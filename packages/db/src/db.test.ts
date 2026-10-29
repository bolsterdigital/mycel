// Integration tests against a real Postgres. They skip without DATABASE_URL (operator role) and
// APP_DATABASE_URL (mycel_app login, subject to RLS); CI provides both via a service container,
// where a missing database is a failure (`requireDatabase`). The RLS catalog checks
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
  issueProofChallenge,
  issueStartedToken,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryMailer,
  memoryPlatform,
  probeForm,
  publishProbePage,
  solveProof,
  runSuffix,
} from '@mycel/core/testing';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  readOutboxEvent,
  uuidv7,
  uuidv7Ids,
} from './index.js';
import { closeTenantWork, requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('postgres adapter', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
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
  const run = runSuffix();
  let tenantA = '';
  let tenantB = '';
  let formId = '';

  // Drains only this suite's tenants (TODO #26). `drainOutbox` claims every tenant's events, and
  // the db suites share one database: a drain here once ingested entitlements.test's
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
    await migrateSchema(operatorUrl);
    tenantA = (await testTenant(operatorDb, `t-a-${run}`, { name: 'A', locales: ['nl', 'en'] })).id;
    tenantB = (await testTenant(operatorDb, `t-b-${run}`, { name: 'B' })).id;
    formId = uuidv7();
    await uow.run(systemPrincipal(tenantA, 'test'), (ctx) => ctx.forms.insert(probeForm(formId)));
    await publishProbePage(invoker, systemPrincipal(tenantA, 'test'), formId);
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantA, tenantB]);
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

    // Opening the link only reads (TODO #22B); the button's post confirms, exactly once even
    // when three posts race (the conditional update on `confirmed_at`), and the list moves to
    // `lists` with the snapshot of the submission as evidence.
    const token = new URL(
      /http:\/\/\S+\/confirm\?token=\S+/.exec(mail[0]!.text)![0]
    ).searchParams.get('token')!;
    const visitor = anonymousPrincipal(tenantA, ['forms:write']);
    const consents = () =>
      operatorDb.transaction().execute(async (trx) => {
        await sql`set local role mycel_worker`.execute(trx);
        const { rows } = await sql<{ props: Record<string, unknown> }>`
          select props from outbox where tenant_id = ${tenantA} and type = 'consent.given'
             and props->>'email' = ${email}`.execute(trx);
        return rows.map((r) => r.props);
      });
    expect(await invoker.run(useCases.previewConfirmation, visitor, { token })).toEqual({
      status: 'pending',
      locale: 'en',
    });
    expect(await consents()).toEqual([]);
    const click = () => invoker.run(useCases.confirmSubscription, visitor, { token });
    const outcomes = (await Promise.all([click(), click(), click()])).map((r) => r.status).sort();
    expect(outcomes).toEqual(['already_confirmed', 'already_confirmed', 'confirmed']);
    expect(await consents()).toEqual([
      expect.objectContaining({
        list: 'newsletter',
        locale: 'en',
        consentTextVersion: probeForm(formId).consentTextVersion,
      }),
    ]);
    expect(await click()).toEqual({ status: 'already_confirmed', locale: 'en' });
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
    const other = (await testTenant(operatorDb, `t-o-${run}`, { name: 'O' })).id;
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
      invoker.run(useCases.getPublished, anonymousPrincipal(tenantB, ['content:read']), {
        type: 'page',
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

  it('sends one confirmation per address per form a day in Postgres, and the refusal commits', async () => {
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
    expect(statuses).toEqual([
      'accepted',
      'recipient-limited',
      'recipient-limited',
      'recipient-limited',
    ]);
  });

  // Brief form-intake § D2.4: a solution is good for one post, also when two arrive at once
  // (the cooldown on the challenge, the same primitive as the recipient's).
  it('lets one of two simultaneous posts with the same proof through', async () => {
    const visitor = anonymousPrincipal(tenantA, ['forms:write'], `ip-proof-${run}`);
    const startedToken = await issueStartedToken(signer, formId, new Date(Date.now() - 10_000));
    const proof = await solveProof(await issueProofChallenge(signer, formId, new Date(), 20));
    const post = (n: number) =>
      invoker.run(useCases.submitForm, visitor, {
        formId,
        values: { email: `proof-${n}-${run}@example.org`, consent: true },
        locale: 'nl',
        spam: { honeypot: '', startedToken, proof },
      });
    const results = await Promise.all([post(1), post(2)]);
    expect(results.map((r) => (r.status === 'rejected' ? r.reason : r.status)).sort()).toEqual([
      'accepted',
      'spam',
    ]);
  });
});
