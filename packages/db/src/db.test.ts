// Integration tests against a real Postgres. They skip without DATABASE_URL (operator role) and
// APP_DATABASE_URL (mycel_app login, subject to RLS); CI provides both via a service container
// and sets E2E_REQUIRED=1, which turns a missing database into a failure. The RLS catalog checks
// live in rls.test.ts.

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
import { FakeSigner, MemoryMailer, probeForm, probePage } from '@mycel/core/testing';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  drainOutbox,
  migrate,
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
  const uow = createUnitOfWork(appDb, { clock, ids: uuidv7Ids, signer });
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
      from: { email: 'noreply@example.org' },
      publicBaseUrl: 'http://localhost:5173',
    }),
  ];
  const run = Math.random().toString(36).slice(2, 8);
  let tenantA = '';
  let tenantB = '';
  let formId = '';

  beforeAll(async () => {
    await migrate(operatorUrl!, { appPassword: process.env['MYCEL_APP_PASSWORD'], log: () => {} });
    tenantA = (
      await upsertTenant(operatorDb, {
        id: uuidv7(),
        slug: `t-a-${run}`,
        name: 'A',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
      })
    ).id;
    tenantB = (
      await upsertTenant(operatorDb, {
        id: uuidv7(),
        slug: `t-b-${run}`,
        name: 'B',
        defaultLocale: 'nl',
        locales: ['nl'],
      })
    ).id;
    formId = uuidv7();
    await uow.run(systemPrincipal(tenantA, 'test'), (ctx) => ctx.forms.insert(probeForm(formId)));
    await invoker.run(useCases.createPage, systemPrincipal(tenantA, 'test'), probePage(formId));
  });

  afterAll(async () => {
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

    // Drain until our event is handled (other suites or a running worker may share the outbox).
    for (let i = 0; i < 20 && !mailer.sent.some((m) => m.to.email === email); i++)
      await drainOutbox(operatorDb, subscribers);

    const supporter = await invoker.run(useCases.getSupporter, systemPrincipal(tenantA, 'test'), {
      email,
    });
    expect(supporter.lists).toEqual(['newsletter']);
    expect(mailer.sent.filter((m) => m.to.email === email)).toHaveLength(1);
    expect(mailer.sent.find((m) => m.to.email === email)?.subject).toBe(
      'Confirm your subscription to A'
    );

    // The stored projection equals a rebuild from the log (ADR 003 rule 3).
    const events = await uow.run(systemPrincipal(tenantA, 'test'), (ctx) =>
      ctx.supporters.eventsFor(email)
    );
    expect(events).toHaveLength(1);
    expect(rebuildProjection(events)).toEqual(supporter);

    // Re-ingesting the same event is a no-op (dedup on the deterministic id).
    const again = await uow.run(systemPrincipal(tenantA, 'test'), (ctx) =>
      ctx.supporters.appendEvent(events[0]!)
    );
    expect(again).toBe(false);
  });

  it('isolates tenants through RLS, not through where-clauses', async () => {
    await expect(
      invoker.run(useCases.getPage, anonymousPrincipal(tenantB, ['content:read']), {
        slug: 'signup',
      })
    ).rejects.toMatchObject({ code: 'not_found' });

    // Without a tenant context the application role sees nothing at all.
    const { rows } = await sql<{ n: string }>`select count(*) as n from pages`.execute(appDb);
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
