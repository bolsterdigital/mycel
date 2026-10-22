// Integration tests against a real Postgres. They skip without DATABASE_URL (operator role) and
// APP_DATABASE_URL (mycel_app login, subject to RLS); CI provides both via a service container
// and sets E2E_REQUIRED=1, which turns a missing database into a failure. The RLS catalog checks
// live in rls.conformance.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  confirmationMailSubscriber,
  supporterIngestSubscriber,
  systemPrincipal,
  anonymousPrincipal,
  useCases,
  rebuildProjection,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryMailer,
  memoryPlatform,
  probeForm,
  publishProbePage,
} from '@mycel/core/testing';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  migrate,
  readOutboxEvent,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

describe.skipIf(!operatorUrl || !appUrl)('postgres adapter', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const signer = new FakeSigner();
  const clock = { now: () => new Date() };
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer,
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const mailer = new MemoryMailer();
  const tenants = createTenantDirectory(appDb);
  const subscribers = [
    supporterIngestSubscriber(uow),
    confirmationMailSubscriber({
      mailer,
      signer,
      clock,
      tenants,
      uow,
      from: { email: 'noreply@example.org' },
      platform: memoryPlatform,
    }),
  ];
  const run = Math.random().toString(36).slice(2, 8);
  let tenantA = '';
  let tenantB = '';
  let formId = '';

  // Drains only this suite's tenants (TODO #26). `drainOutbox` claims every tenant's events, and
  // the db suites share one database: a drain here once ingested entitlements.conformance's
  // signups and released their admission seats mid-assertion. Same row bookkeeping as the
  // worker, read as mycel_worker like it. Rejected: a tenant filter on `drainOutbox` (production
  // code for a test) and running the db suites serially (slower, and it hides the coupling).
  // `drainOutbox` itself runs in the e2e signup flow, through the worker process.
  async function drainOwn(): Promise<void> {
    const { rows } = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return sql<{ id: string }>`
        select id from outbox
        where tenant_id in (${tenantA}, ${tenantB}) and processed_at is null
        order by id`.execute(trx);
    });
    for (const { id } of rows) {
      const event = await readOutboxEvent(operatorDb, id);
      if (!event) continue;
      const handled = subscribers.filter((s) => s.types.includes(event.type));
      for (const sub of handled) await sub.handle(event);
      await operatorDb.transaction().execute(async (trx) => {
        await sql`set local role mycel_worker`.execute(trx);
        await trx
          .updateTable('outbox')
          .set({ delivered_to: handled.map((s) => s.name), processed_at: new Date() })
          .where('id', '=', id)
          .execute();
      });
    }
  }

  beforeAll(async () => {
    await migrate(operatorUrl!, { appPassword: process.env['MYCEL_APP_PASSWORD'], log: () => {} });
    tenantA = (
      await upsertTenant(
        operatorDb,
        {
          id: uuidv7(),
          slug: `t-a-${run}`,
          name: 'A',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
        },
        { platformDomain: 'localhost' }
      )
    ).id;
    tenantB = (
      await upsertTenant(
        operatorDb,
        {
          id: uuidv7(),
          slug: `t-b-${run}`,
          name: 'B',
          defaultLocale: 'nl',
          locales: ['nl'],
        },
        { platformDomain: 'localhost' }
      )
    ).id;
    formId = uuidv7();
    await uow.run(systemPrincipal(tenantA, 'test'), (ctx) => ctx.forms.insert(probeForm(formId)));
    await publishProbePage(invoker, systemPrincipal(tenantA, 'test'), formId);
  });

  afterAll(async () => {
    // Each confirmation mail planned a `mail.reconcile` job; close this suite's so they neither
    // run under a worker on the same database nor pile up ahead of recovery.conformance's claim.
    await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      await sql`update jobs set done_at = now()
                where done_at is null and type = 'mail.reconcile'
                  and tenant_id in (${tenantA}, ${tenantB})`.execute(trx);
    });
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('runs a signup through outbox, supporter projection and confirmation mail', async () => {
    const email = `ada-${run}@example.org`;
    const result = await invoker.run(useCases.submitForm, systemPrincipal(tenantA, 'test'), {
      formId,
      values: { email, consent: true },
      locale: 'en',
      pageUrl: 'http://localhost:5173/probe/signup',
    });
    expect(result.status).toBe('accepted');

    await drainOwn();

    const supporter = await invoker.run(useCases.getSupporter, systemPrincipal(tenantA, 'test'), {
      email,
    });
    expect(supporter).toMatchObject({ lists: [], pendingLists: ['newsletter'] });
    const mail = mailer.sent.filter((m) => m.to.email === email);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toBe('Confirm your subscription to A');

    // The stored projection equals a rebuild from the log (ADR 003 rule 3).
    const events = await uow.run(systemPrincipal(tenantA, 'test'), (ctx) =>
      ctx.supporters.eventsFor(supporter.id)
    );
    expect(events).toHaveLength(1);
    expect(rebuildProjection(events)).toEqual(supporter);

    // Re-ingesting the same event is a no-op (dedup on the deterministic id).
    const again = await uow.run(systemPrincipal(tenantA, 'test'), (ctx) =>
      ctx.supporters.appendEvent({ ...events[0]!, supporter_id: supporter.id })
    );
    expect(again).toBe(false);

    // Following the link as a visitor confirms once; the list moves to `lists`.
    const token = new URL(
      /http:\/\/\S+\/confirm\?token=\S+/.exec(mail[0]!.text)![0]
    ).searchParams.get('token')!;
    const click = () =>
      invoker.run(useCases.confirmSubscription, anonymousPrincipal(tenantA, ['forms:write']), {
        token,
      });
    expect(await click()).toEqual({ status: 'confirmed' });
    expect(await click()).toEqual({ status: 'already_confirmed' });
    await drainOwn();
    const confirmed = await invoker.run(useCases.getSupporter, systemPrincipal(tenantA, 'test'), {
      email,
    });
    expect(confirmed).toMatchObject({ id: supporter.id, lists: ['newsletter'], pendingLists: [] });
    const log = await uow.run(systemPrincipal(tenantA, 'test'), (ctx) =>
      ctx.supporters.eventsFor(supporter.id)
    );
    expect(log.map((e) => e.type)).toEqual(['newsletter.subscribed', 'consent.given']);
    expect(rebuildProjection(log)).toEqual(confirmed);
    expect(mailer.sent.filter((m) => m.to.email === email)).toHaveLength(1);
  });

  it("leaves other suites' outbox events alone (TODO #26)", async () => {
    const other = (
      await upsertTenant(
        operatorDb,
        { id: uuidv7(), slug: `t-o-${run}`, name: 'O', defaultLocale: 'nl', locales: ['nl'] },
        { platformDomain: 'localhost' }
      )
    ).id;
    const id = uuidv7();
    await uow.run(systemPrincipal(other, 'test'), (ctx) =>
      ctx.events.publish({
        id,
        type: 'test.untouched',
        tenantId: other,
        occurredAt: new Date(),
        actor: { kind: 'system', job: 'test' },
        props: {},
      })
    );
    const state = () =>
      operatorDb.transaction().execute(async (trx) => {
        await sql`set local role mycel_worker`.execute(trx);
        const { rows } = await sql<{ processed_at: Date | null; attempts: number }>`
          select processed_at, attempts from outbox where id = ${id}`.execute(trx);
        return rows[0];
      });
    await drainOwn();
    expect(await state()).toEqual({ processed_at: null, attempts: 0 });
    // Close it so it does not linger in the shared outbox.
    await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      await trx
        .updateTable('outbox')
        .set({ processed_at: new Date() })
        .where('id', '=', id)
        .execute();
    });
  });

  it('isolates tenants through RLS, not through where-clauses', async () => {
    await expect(
      invoker.run(useCases.getPage, anonymousPrincipal(tenantB, ['content:read']), {
        slug: 'signup',
      })
    ).rejects.toMatchObject({ code: 'not_found' });

    // Without a tenant context the application role sees nothing at all.
    const { rows } = await sql<{ n: string }>`select count(*) as n from content_items`.execute(
      appDb
    );
    expect(Number(rows[0]?.n)).toBe(0);

    // And it cannot write a row for another tenant even inside a transaction.
    await expect(
      uow.run(systemPrincipal(tenantB, 'test'), (ctx) =>
        ctx.events.publish({
          id: uuidv7(),
          type: 'x',
          tenantId: tenantA,
          occurredAt: new Date(),
          actor: { kind: 'system', job: 't' },
          props: {},
        })
      )
    ).rejects.toThrow(/row-level security/);
  });

  it('rate-limits per e-mail address in Postgres, and the rejection commits', async () => {
    const email = `busy-${run}@example.org`;
    const statuses: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await invoker.run(useCases.submitForm, systemPrincipal(tenantA, 'test'), {
        formId,
        values: { email, consent: true },
        locale: 'nl',
      });
      statuses.push(r.status === 'rejected' ? r.reason : r.status);
    }
    expect(statuses).toEqual(['accepted', 'accepted', 'accepted', 'rate-limited']);
  });
});
