// The erasure register in memory (ADR 019 rule 8, TODO #18d): the same contract as
// packages/db/src/erasures.conformance.test.ts over Postgres, so a suite on MemoryUnitOfWork
// sees what production does. A signup gives every kind of copy: the submission, the outbox
// event, the event log and projection after ingest, and the confirmation's intent and job.

import { beforeEach, describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import { buildRegistry, useCases } from '../use-cases.js';
import {
  FakeClock,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  probeForm,
  probeTenant,
} from '../testing/index.js';
import { confirmationMailSubscriber } from '../mailing/confirmation.js';
import { supporterIngestSubscriber } from './service.js';
import { erasureEmailHash, tombstoneEmail } from './erasure.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const OTHER = '01900000-0000-7000-8000-00000000bbbb';
const FORM = '01900000-0000-7000-8000-00000000f000';

describe('ctx.erasures in memory', () => {
  let uow: MemoryUnitOfWork;
  const admin = (tenant = TENANT) => systemPrincipal(tenant, 'test');

  async function signup(tenant: string, email: string) {
    const invoker = new Invoker(buildRegistry(), uow);
    await uow.run(admin(tenant), (ctx) => ctx.forms.insert(probeForm(FORM)));
    const result = await invoker.run(useCases.submitForm, admin(tenant), {
      formId: FORM,
      values: { email, consent: true },
      locale: 'nl',
    });
    if (result.status !== 'accepted') throw new Error(result.status);
    const mail = confirmationMailSubscriber({
      mailer: new MemoryMailer(),
      signer: uow.signer,
      clock: uow.clock,
      tenants: new MemoryTenants([probeTenant(TENANT), probeTenant(OTHER)]),
      uow,
      from: { email: 'noreply@example.org' },
      platform: { platformOrigin: 'https://example.org', siteUrlMode: 'path' },
    });
    // Handled, not drained: the outbox keeps its events, as processed rows stay in Postgres.
    for (const event of uow.store.outbox.filter((e) => e.tenantId === tenant)) {
      await supporterIngestSubscriber(uow).handle(event);
      await mail.handle(event);
    }
  }
  const copies = (tenant: string, email: string) => {
    const s = uow.store.for(tenant);
    const text = (v: unknown) => JSON.stringify(v).toLowerCase().includes(email);
    return {
      events: [...s.events.values()].filter(text).length,
      supporters: [...s.projections.values()].filter(text).length,
      submissions: [...s.submissions.values()].filter(text).length,
      outbox: uow.store.outbox.filter((e) => e.tenantId === tenant && text(e)).length,
      jobs: uow.store.jobs.filter((j) => j.tenantId === tenant && text(j)).length,
      erasures: [...s.erasures.values()].filter(text).length,
    };
  };
  const none = { events: 0, supporters: 0, submissions: 0, outbox: 0, jobs: 0, erasures: 0 };

  beforeEach(async () => {
    uow = new MemoryUnitOfWork({ clock: new FakeClock() });
    await signup(TENANT, 'ada@example.org');
    await signup(OTHER, 'ada@example.org');
  });

  it('registers the hash, never the address, once per supporter', async () => {
    const id = (await uow.run(admin(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    await uow.run(admin(), (ctx) => ctx.erasures.register(id, 'Ada@Example.org'));
    await uow.run(admin(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    const register = uow.store.for(TENANT).erasures;
    expect(register.size).toBe(1);
    expect(register.get(id)?.emailHash).toBe(await erasureEmailHash(TENANT, 'ada@example.org'));
    expect(copies(TENANT, 'ada@example.org').erasures).toBe(0);
  });

  it('applies to every copy in the tenant, keeps the event count and is idempotent', async () => {
    const s = uow.store.for(TENANT);
    const id = (await uow.run(admin(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    const events = s.events.size;
    expect(s.mailSends.size).toBe(1);
    expect(copies(TENANT, 'ada@example.org')).toMatchObject({
      events: events,
      supporters: 1,
      submissions: 1,
    });

    await uow.run(admin(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    expect(await uow.run(admin(), (ctx) => ctx.erasures.apply())).toBeGreaterThan(0);
    expect(copies(TENANT, 'ada@example.org')).toEqual(none);
    expect(s.events.size).toBe(events);
    expect([...s.events.values()].every((e) => e.email === tombstoneEmail(id))).toBe(true);
    expect(s.projections.get(id)).toMatchObject({ email: tombstoneEmail(id), lists: [] });
    expect(s.mailSends.size).toBe(0);
    expect(uow.store.jobs.filter((j) => j.tenantId === TENANT)).toEqual([]);

    expect(await uow.run(admin(), (ctx) => ctx.erasures.apply())).toBe(0);
    // The other tenant's supporter with the same address is untouched.
    expect(copies(OTHER, 'ada@example.org')).toMatchObject({ supporters: 1, submissions: 1 });
  });

  it('finds a submission whose supporter was never ingested, by the registered hash', async () => {
    const s = uow.store.for(TENANT);
    const id = (await uow.run(admin(), (ctx) => ctx.supporters.getProjection('ada@example.org')))!
      .id;
    // As after a restore of a backup older than the ingest: the submission, no projection.
    s.projections.clear();
    s.events.clear();
    await uow.run(admin(), (ctx) => ctx.erasures.register(id, 'ada@example.org'));
    await uow.run(admin(), (ctx) => ctx.erasures.apply());
    expect(copies(TENANT, 'ada@example.org')).toEqual(none);
  });
});
