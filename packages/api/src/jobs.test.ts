// The handler registry over in-memory ports: a tenant job runs in its tenant's unit of work as a
// system principal with the tenant's current status, a platform job never runs with a tenant,
// and every job type has a handler.
// The platform handlers' SQL is proven in packages/db/src/jobs.conformance.test.ts.

import { describe, expect, it } from 'vitest';
import {
  Invoker,
  JobPayloads,
  RECONCILE_LAG_MS,
  UseCaseError,
  buildRegistry,
  renderConfirmationMail,
  sendOnce,
  systemPrincipal,
  useCases,
  requireActive,
  type DomainEvent,
  type JobRecord,
  type Mailer,
  type Principal,
} from '@mycel/core';
import {
  FakeClock,
  MemoryIdentityStore,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  probeTenant,
} from '@mycel/core/testing';
import type { createDb } from '@mycel/db';
import { RECURRING_JOBS, jobHandlers, tenantJob } from './jobs.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
// The platform handlers are not called here; the registry only needs the connection's shape.
const operatorDb = {} as ReturnType<typeof createDb>;

const job = (over: Partial<JobRecord>): JobRecord => ({
  id: 'j',
  tenantId: TENANT,
  type: 'hostnames.reverify',
  key: `hostnames.reverify:${TENANT}:www.example.org`,
  runAt: new Date(),
  payload: { hostname: 'www.example.org' },
  attempts: 1,
  maxAttempts: 10,
  claimedAt: new Date(),
  doneAt: null,
  lastError: null,
  createdAt: new Date(),
  ...over,
});

describe('job handlers', () => {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  uow.store.addPlatformHostname(probeTenant(TENANT), 'localhost');
  const identity = new MemoryIdentityStore(uow.store, new MemoryTenants());
  const mail = { mailer: new MemoryMailer(), clock, sources: {} };
  const handlers = jobHandlers({ uow, operatorDb, identity, mail });

  it('has a handler for every job type, and plans only platform types itself', () => {
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(JobPayloads).sort());
    for (const r of RECURRING_JOBS) expect(Object.keys(JobPayloads)).toContain(r.type);
  });

  it('runs a tenant job in its tenant, and refuses one without a tenant or with a bad payload', async () => {
    // The hostname is gone (never added): done, nothing planned.
    expect(await handlers['hostnames.reverify']!(job({}))).toEqual({});
    await expect(handlers['hostnames.reverify']!(job({ tenantId: null }))).rejects.toThrow(
      /tenant job/
    );
    await expect(handlers['hostnames.reverify']!(job({ payload: {} }))).rejects.toThrow();
  });

  it('refuses a platform job that carries a tenant', async () => {
    for (const type of ['events.partitions', 'rate_limits.sweep', 'media.orphans'])
      await expect(handlers[type]!(job({ type, payload: {} }))).rejects.toThrow(/platform job/);
  });

  // Review round 1 of TODO #16, audit point 4: a scheduled publication must see a suspension
  // that happened after it was planned, so the principal carries the status of the moment.
  it("gives a tenant job the tenant's current status, which requireActive refuses when suspended", async () => {
    const seen: Principal[] = [];
    const handler = tenantJob({ uow, identity }, 'hostnames.reverify', async (ctx) => {
      seen.push(ctx.principal);
      requireActive(ctx.principal);
      return {};
    });

    uow.store.setAccess(TENANT, { status: 'suspended' });
    await expect(handler(job({}))).rejects.toSatisfy(
      (e) => e instanceof UseCaseError && e.code === 'suspended'
    );
    expect(seen.at(-1)?.tenantStatus).toBe('suspended');

    uow.store.setAccess(TENANT, { status: 'active', entitlements: { 'supporters.max': 7 } });
    await expect(handler(job({}))).resolves.toEqual({});
    expect(seen.at(-1)).toMatchObject({
      tenantStatus: 'active',
      entitlements: { 'supporters.max': 7 },
    });
  });

  it('purges a deleted asset and sweeps orphans per tenant (TODO #10)', async () => {
    const OTHER = '01900000-0000-7000-8000-00000000bbbb';
    const media = new MemoryUnitOfWork({ clock });
    const invoker = new Invoker(buildRegistry(), media);
    const system = systemPrincipal(TENANT, 'test');
    const m = await invoker.run(
      useCases.uploadMedia,
      system,
      useCases.uploadMedia.examples[0].input
    );
    await invoker.run(useCases.deleteMedia, system, { id: m.id });
    const purge = media.store.jobs.find((j) => j.type === 'media.purge')!;
    const swept: string[] = [];
    const h = jobHandlers({
      uow: media,
      operatorDb,
      mail,
      identity: new MemoryIdentityStore(media.store, new MemoryTenants()),
      tenantIds: async () => [TENANT, OTHER],
    });
    await h['media.purge']!(purge);
    expect(media.store.for(TENANT).media.size).toBe(0);

    const stray = (tenant: string) => `tenants/${tenant}/media/${uuid}/original.png`;
    const uuid = '01900000-0000-7000-8000-0000000000ff';
    for (const t of [TENANT, OTHER])
      await media.blobs.put(stray(t), new Uint8Array(1), { contentType: 'image/png' });
    clock.advance(25 * 60 * 60 * 1000);
    await h['media.orphans']!(job({ tenantId: null, type: 'media.orphans', payload: {} }));
    for await (const b of media.blobs.list('tenants/')) swept.push(b.key);
    expect(swept).toEqual([]);
  });

  describe('mail.reconcile (brief #22C)', () => {
    const OTHER = '01900000-0000-7000-8000-00000000bbbb';
    const message = renderConfirmationMail({
      locale: 'en',
      tenantName: 'Probe',
      confirmUrl: 'https://example.org/c',
      from: { email: 'noreply@example.org' },
      to: 'ada@example.org',
    });
    const event: DomainEvent = {
      id: '01900000-0000-7000-8000-00000000e0e1',
      type: 'newsletter.subscribed',
      tenantId: TENANT,
      occurredAt: new Date(),
      actor: { kind: 'system', job: 'test' },
      props: {},
    };

    /** A provider that accepts and loses the response, then lists what it accepted. */
    class LosingMailer extends MemoryMailer implements Mailer {
      lose = true;
      override async send(m: typeof message, key: string) {
        const r = await super.send(m, key);
        if (this.lose) throw new Error('aborted');
        return r;
      }
    }

    function setup(outbox: DomainEvent[] = [event]) {
      const clock = new FakeClock();
      const uow = new MemoryUnitOfWork({ clock });
      const mailer = new LosingMailer();
      const identity = new MemoryIdentityStore(uow.store, new MemoryTenants());
      const sources = { test: async () => message };
      const h = jobHandlers({
        uow,
        operatorDb,
        identity,
        mail: {
          mailer,
          clock,
          sources,
          readEvent: async (id) => outbox.find((e) => e.id === id) ?? null,
        },
      })['mail.reconcile']!;
      return { clock, uow, mailer, h };
    }

    it('recovers a lost response from the job alone, without the outbox', async () => {
      const { clock, uow, mailer, h } = setup();
      expect(await sendOnce({ mailer, clock, uow }, event, 'test', message)).toBe('unknown');
      const planned = uow.store.jobs.find((j) => j.type === 'mail.reconcile')!;
      expect(planned.runAt).toEqual(new Date(clock.now().getTime() + RECONCILE_LAG_MS));
      mailer.lose = false;
      clock.advance(RECONCILE_LAG_MS);
      expect(await h(planned)).toEqual({});
      expect(mailer.sent).toHaveLength(1);
      expect(uow.store.for(TENANT).mailSends.get(`test:${event.id}`)?.providerId).toBe('mem-1');
    });

    it("uses the outbox event only for the job's own tenant", async () => {
      const { h } = setup([{ ...event, tenantId: OTHER }]);
      const payload = { key: `test:${event.id}`, subscriber: 'test', eventId: event.id };
      const j = job({ type: 'mail.reconcile', key: `mail.reconcile:test:${event.id}`, payload });
      await expect(h(j)).rejects.toThrow(/another tenant/);
      await expect(h({ ...j, tenantId: null })).rejects.toThrow(/tenant job/);
    });

    it('fails on a missing event, an unknown subscriber or a forged key', async () => {
      const payload = { key: `test:${event.id}`, subscriber: 'test', eventId: event.id };
      const j = job({ type: 'mail.reconcile', key: `mail.reconcile:test:${event.id}`, payload });
      await expect(setup([]).h(j)).rejects.toThrow(/not found/);
      await expect(
        setup().h({ ...j, payload: { ...payload, subscriber: 'other', key: `other:${event.id}` } })
      ).rejects.toThrow(/no mail source/);
      await expect(setup().h({ ...j, payload: { ...payload, key: 'test:x' } })).rejects.toThrow(
        /does not match/
      );
    });

    it('sends nothing for a suspended tenant and looks again in a day', async () => {
      const { clock, uow, mailer, h } = setup();
      uow.store.setAccess(TENANT, { status: 'suspended' });
      const payload = { key: `test:${event.id}`, subscriber: 'test', eventId: event.id };
      const j = job({ type: 'mail.reconcile', key: `mail.reconcile:test:${event.id}`, payload });
      expect(await h(j)).toEqual({ next: new Date(clock.now().getTime() + 24 * 60 * 60 * 1000) });
      expect(mailer.sent).toHaveLength(0);
    });
  });
});
