// The handler registry over in-memory ports: a tenant job runs in its tenant's unit of work as a
// system principal with the tenant's current status, a platform job never runs with a tenant,
// and every job type has a handler.
// The platform handlers' SQL is proven in packages/db/src/operations/jobs.test.ts. The erasure
// jobs are proven against Postgres at the end of this file: they need the operator connection.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  JobPayloads,
  RECONCILE_LAG_MS,
  SUSPENDED_RETRY_MS,
  UseCaseError,
  buildRegistry,
  renderConfirmationMail,
  sendOnce,
  systemPrincipal,
  useCases,
  requireActive,
  planConnectionIntent,
  type DomainEvent,
  type JobRecord,
  type Mailer,
  type Principal,
  MEDIA_TRASH_RETENTION_MS,
  DEFAULT_ACCESS,
  supporterIngestSubscriber,
  monthsBefore,
} from '@mycel/core';
import {
  FakeClock,
  FakeConnectionTransport,
  FakeDns,
  MemoryIdentityStore,
  MemoryMailer,
  MemoryTenants,
  MemoryUnitOfWork,
  probeTenant,
  probeForm,
  principal,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
  testPlatformActor,
  TENANT,
} from '@mycel/core/testing';
import {
  createDb,
  createUnitOfWork,
  readOutboxEvent,
  runJobs,
  setStatus,
  uuidv7,
  uuidv7Ids,
} from '@mycel/db';
import {
  asRole,
  closeTenantWork,
  migrateSchema,
  requireDatabase,
  testTenant,
} from '@mycel/db/testing';
import { RECURRING_JOBS, jobHandlers, tenantJob } from './jobs.js';

// The platform handlers are not called here; the registry only needs the connection's shape.
const operatorDb = {} as ReturnType<typeof createDb>;

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

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
  failedAt: null,
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
    await expect(
      handlers['person.erase']!(
        job({ type: 'person.erase', tenantId: null, payload: { personIds: [TENANT] } })
      )
    ).rejects.toThrow(/tenant job/);
    // An erasure job names no address and is bound to the tenant on its row.
    const erase = { type: 'supporter.erase', key: 'supporter.erase:x' };
    await expect(
      handlers['supporter.erase']!(
        job({ ...erase, tenantId: null, payload: { supporterId: TENANT } })
      )
    ).rejects.toThrow(/tenant job/);
    await expect(
      handlers['supporter.erase']!(job({ ...erase, payload: { email: 'a@example.org' } }))
    ).rejects.toThrow();
  });

  it('refuses a platform job that carries a tenant', async () => {
    for (const type of [
      'events.partitions',
      'rate_limits.sweep',
      'media.orphans',
      'erasures.apply',
      'retention.apply',
    ])
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
    clock.advance(MEDIA_TRASH_RETENTION_MS + 1);
    const swept: string[] = [];
    const h = jobHandlers({
      uow: media,
      operatorDb,
      mail,
      identity: new MemoryIdentityStore(media.store, new MemoryTenants()),
      tenantIds: async () => [TENANT, OTHER],
    });
    await h['media.orphans']!(job({ tenantId: null, type: 'media.orphans', payload: {} }));
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

  it('keeps deleting old assist suggestions after one tenant fails, then fails the job (#84)', async () => {
    const BROKEN = '01900000-0000-7000-8000-00000000cccc';
    const swept: string[] = [];
    const captured: (string | undefined)[] = [];
    const stub = {
      run: async (p: Principal, fn: (ctx: unknown) => Promise<unknown>) => {
        if (p.tenantId === BROKEN) throw new Error('connection reset');
        return fn({ assist: { deleteBefore: async () => (swept.push(p.tenantId), 1) } });
      },
    } as unknown as MemoryUnitOfWork;
    const h = jobHandlers({
      uow: stub,
      operatorDb,
      mail,
      identity,
      tenantIds: async () => [BROKEN, TENANT],
      errors: { capture: (_e, ctx) => void captured.push(ctx?.tenantId) },
    });
    await expect(
      h['assist.retention']!(job({ tenantId: null, type: 'assist.retention', payload: {} }))
    ).rejects.toThrow('assist.retention failed for 1 tenant(s)');
    expect(swept).toEqual([TENANT]);
    expect(captured).toEqual([BROKEN]);
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

  // #8a with #16: schedule, suspend, run the worker's handler. Nothing goes live, the pin stays
  // and the job asks to come back in a day; once the site is active again the pin is published.
  it('keeps a scheduled publication of a suspended site pinned and retries it later', async () => {
    uow.store.setAccess(TENANT, { status: 'active' });
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(TENANT, 'test');
    const { item, revision } = await invoker.run(useCases.createItem, admin, {
      slug: 'scheduled',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'T' },
        blocks: [],
      },
    });
    const at = new Date(clock.now().getTime() + 60_000);
    await invoker.run(useCases.scheduleItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
      at: at.toISOString(),
    });
    const planned = uow.store.jobs.find((j) => j.type === 'content.publish' && !j.doneAt)!;
    clock.advance(120_000);
    const nl = async () =>
      (await invoker.run(useCases.getItem, admin, { itemId: item.id })).item.publication[0]!;

    uow.store.setAccess(TENANT, { status: 'suspended' });
    expect(await handlers['content.publish']!(planned)).toEqual({
      next: new Date(clock.now().getTime() + SUSPENDED_RETRY_MS),
    });
    expect(await nl()).toMatchObject({ status: 'scheduled', scheduledRevisionId: revision.id });

    uow.store.setAccess(TENANT, { status: 'active' });
    expect(await handlers['content.publish']!(planned)).toEqual({});
    expect(await nl()).toMatchObject({ status: 'published', publishedRevisionId: revision.id });
  });
});

describe('connection intent job composition', () => {
  it('keeps the tenant in the job authoritative and refuses a missing transport', async () => {
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, dns: new FakeDns({ 'example.org': ['8.8.8.8'] }) });
    const identity = new MemoryIdentityStore(uow.store, new MemoryTenants());
    const mail = { mailer: new MemoryMailer(), clock, sources: {} };
    const transport = new FakeConnectionTransport();
    const p = systemPrincipal(TENANT, 'test');
    const invoker = new Invoker(buildRegistry(), uow);
    let c = await invoker.run(useCases.createConnection, p, {
      provider: 'webhook',
      accountRef: null,
      externalOwner: 'Fixture',
      maintainer: 'Fixture',
      purpose: 'Fixture',
      direction: 'outbound',
      dataAuthority: 'mycel',
      consentAuthority: 'mycel',
      consentScopes: ['newsletter'],
      formIds: [],
      destination: 'https://example.org/hook',
      contractVersion: 'v1',
      adapterVersion: 'v1',
    });
    c = await invoker.run(useCases.replaceConnectionCredential, p, {
      id: c.id,
      baseVersion: c.version,
      secret: 'fixture',
    });
    c = await invoker.run(useCases.resumeConnection, p, { id: c.id, baseVersion: c.version });
    const supporterId = uow.ids.next();
    const at = clock.now().toISOString();
    await uow.run(p, (ctx) =>
      ctx.supporters.saveProjection({
        id: supporterId,
        email: 'fixture@example.org',
        lists: ['newsletter'],
        pendingLists: [],
        firstSeen: at,
        lastActivity: at,
        appliedThrough: { at, id: 'fixture' },
      })
    );
    const row = await uow.run(p, (ctx) =>
      planConnectionIntent(ctx, {
        connectionId: c.id,
        connectionVersion: c.version,
        businessId: uow.ids.next(),
        source: 'fixture',
        mappingVersion: 'v1',
        supporterId,
        scope: 'newsletter',
      })
    );
    const j = job({ type: 'connections.run', payload: { intentId: row.id } });
    const disabled = jobHandlers({ uow, operatorDb, identity, mail })['connections.run']!;
    await expect(disabled(j)).rejects.toThrow('not configured');
    const handler = jobHandlers({
      uow,
      operatorDb,
      identity,
      mail,
      connections: {
        transport,
        sources: {
          fixture: {
            prepare: async () => ({ ready: true as const, payload: { synthetic: true } }),
          },
        },
      },
    })['connections.run']!;
    await expect(handler({ ...j, tenantId: null })).rejects.toThrow('tenant');
    await handler({ ...j, tenantId: '01900000-0000-7000-8000-00000000bbbb' });
    expect(transport.dispatched).toHaveLength(0);
    await handler(j);
    expect(transport.dispatched).toHaveLength(1);
  });
  it('Mailchimp callbacks run once while one canonical comparison job recurs', async () => {
    const uow = new MemoryUnitOfWork();
    const clock = uow.clock;
    const identity = new MemoryIdentityStore(uow.store, new MemoryTenants());
    const mail = { mailer: new MemoryMailer(), clock, sources: {} };
    const handler = jobHandlers({
      uow,
      operatorDb,
      identity,
      mail,
      connections: {
        transport: new FakeConnectionTransport(),
        sources: {},
        mailchimpSync: async () => true,
      },
    })['connections.mailchimp.sync']!;
    const intentId = '01900000-0000-7000-8000-000000000001';
    expect(
      await handler(
        job({
          type: 'connections.mailchimp.sync',
          key: `connections.mailchimp.sync:${intentId}`,
          payload: { intentId },
        })
      )
    ).toEqual({ next: new Date(clock.now().getTime() + 3600_000) });
    expect(
      await handler(
        job({
          type: 'connections.mailchimp.sync',
          key: `mailchimp.callback:${intentId}:one`,
          payload: { intentId },
        })
      )
    ).toEqual({});
  });
});

// An ordinary erasure request reaches every copy through the worker, with no script. The
// fixture is a real signup (submission, outbox event) and its ingest (events, projection).
describe.skipIf(skip)('erasure jobs against Postgres', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const clock = { now: () => new Date() };
  const uowDeps = {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  };
  const uow = createUnitOfWork(appDb, uowDeps);
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  const address = `erase-job-${run}@example.org`;
  const tenants: string[] = [];
  let sweepTenants: string[] = [];
  const handlers = jobHandlers({
    uow,
    operatorDb,
    identity: { tenantAccess: async () => DEFAULT_ACCESS },
    mail: { mailer: new MemoryMailer(), clock, sources: {} },
    tenantIds: async () => sweepTenants,
  });
  const eraser = (tenantId: string, change: Partial<Principal> = {}): Principal =>
    principal({ tenantId, capabilities: ['supporters:erase', 'supporters:read'], ...change });

  async function newTenant(name: string): Promise<string> {
    const id = (await testTenant(operatorDb, `${name}-${run}`)).id;
    tenants.push(id);
    return id;
  }

  /** A signup and its ingest; returns the supporter id. */
  async function signup(tenantId: string): Promise<string> {
    const admin = systemPrincipal(tenantId, 'erasure-job-test');
    const formId = uuidv7();
    await uow.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
    const submitted = await invoker.run(useCases.submitForm, admin, {
      formId,
      values: { email: address, consent: true },
      locale: 'nl',
    });
    if (submitted.status !== 'accepted') throw new Error(`signup ${submitted.status}`);
    const ids = await asRole(operatorDb, 'mycel_worker', async (trx) =>
      (
        await sql<{ id: string }>`select id from outbox where tenant_id = ${tenantId}
          and type = 'newsletter.subscribed'`.execute(trx)
      ).rows.map((r) => r.id)
    );
    for (const id of ids)
      await supporterIngestSubscriber(uow).handle((await readOutboxEvent(operatorDb, id))!);
    // Delivered by hand; a worker of another checkout on this database must not act on them.
    await closeTenantWork(operatorDb, [tenantId]);
    return (await uow.run(admin, (ctx) => ctx.supporters.getProjection(address)))!.id;
  }

  /** Rows of the tenant that still carry the address, per table, read as mycel_app. */
  async function copies(tenantId: string): Promise<Record<string, number>> {
    return asRole(operatorDb, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
      const count = async (table: string) =>
        Number(
          (
            await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} t
              where t::text ilike ${'%' + address + '%'}`.execute(trx)
          ).rows[0]!.n
        );
      return {
        events: await count('events'),
        supporters: await count('supporters'),
        form_submissions: await count('form_submissions'),
      };
    });
  }
  const none = { events: 0, supporters: 0, form_submissions: 0 };

  /** The open `supporter.erase` jobs of a tenant, as the worker sees them. */
  const eraseJobs = (tenantId: string) =>
    asRole(
      operatorDb,
      'mycel_worker',
      async (trx) =>
        (
          await sql<{
            key: string;
            payload: unknown;
            attempts: number;
          }>`select key, payload, attempts
          from jobs where tenant_id = ${tenantId} and type = 'supporter.erase'
          and done_at is null`.execute(trx)
        ).rows
    );

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('erases every copy of a suspended site through the worker, and nothing of another site', async () => {
    const suspended = await newTenant('erase-job');
    const other = await newTenant('erase-job-other');
    const id = await signup(suspended);
    await signup(other);
    await setStatus(operatorDb, suspended, 'suspended', testPlatformActor);
    expect(await copies(suspended)).not.toEqual(none);

    const request = eraser(suspended, { tenantStatus: 'suspended' });
    const result = await invoker.run(useCases.eraseSupporter, request, { supporterId: id });
    expect(result).toMatchObject({ id, created: true, applied: false, secured: false });
    // The front registered and planned; it erased nothing (it cannot enter mycel_erasure).
    expect(await copies(suspended)).not.toEqual(none);
    const planned = await eraseJobs(suspended);
    expect(planned).toEqual([
      { key: `supporter.erase:${id}`, payload: { supporterId: id }, attempts: 0 },
    ]);
    // Migration 0047: the audit row with effect `erase` is accepted, and names no address.
    const audit = await asRole(operatorDb, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${suspended}, true)`.execute(trx);
      return (
        await sql<{ row: string }>`select a::text as row from audit_log a
          where operation = 'supporter.erase' and effect = 'erase'`.execute(trx)
      ).rows;
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.row).not.toContain(address);

    const ran = await runJobs(operatorDb, handlers, {
      tenantId: suspended,
      types: ['supporter.erase'],
    });
    expect(ran).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(await copies(suspended)).toEqual(none);
    expect(await copies(other)).not.toEqual(none);
    await expect(
      invoker.run(useCases.getSupporterErasure, request, { supporterId: id })
    ).resolves.toMatchObject({ id, applied: true, secured: false });
  });

  it('erases a person of a suspended site through the worker (ADR 034)', async () => {
    const tenant = await newTenant('erase-person');
    const person = await invoker.run(useCases.createPerson, systemPrincipal(tenant, 'test'), {
      slug: 'gone',
      name: `Gone ${run}`,
    });
    await setStatus(operatorDb, tenant, 'suspended', testPlatformActor);
    const request = eraser(tenant, { tenantStatus: 'suspended' });
    const result = await invoker.run(useCases.erasePeople, request, { personIds: [person.id] });
    expect(result).toMatchObject({ created: [person.id], people: [{ applied: false }] });
    const ran = await runJobs(operatorDb, handlers, { tenantId: tenant, types: ['person.erase'] });
    expect(ran).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    const again = await invoker.run(useCases.erasePeople, request, { personIds: [person.id] });
    expect(again).toMatchObject({ created: [], people: [{ applied: true }] });
  });

  it('serialises two requests for one supporter: one registration, one job, one created', async () => {
    const tenant = await newTenant('erase-twice');
    const id = await signup(tenant);
    // Hold the address lock until both requests have read "not registered" and wait on it, so
    // the second sees the first's registration only by reading again under the lock.
    let release = () => {};
    let held = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((r) => (held = r));
    const holder = uow.run(systemPrincipal(tenant, 'erasure-lock'), async (ctx) => {
      await ctx.supporters.lock(address);
      held();
      await gate;
    });
    await holding;
    const requests = [0, 1].map(() =>
      invoker.run(useCases.eraseSupporter, eraser(tenant), { supporterId: id })
    );
    const waiting = async () =>
      Number(
        (
          await sql<{ n: string }>`select count(*) as n from pg_locks
            where locktype = 'advisory' and not granted`.execute(operatorDb)
        ).rows[0]!.n
      );
    for (let i = 0; i < 100 && (await waiting()) < 2; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(await waiting()).toBeGreaterThanOrEqual(2);
    release();
    await holder;
    const results = await Promise.all(requests);
    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(await eraseJobs(tenant)).toHaveLength(1);
    const registered = await asRole(operatorDb, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenant}, true)`.execute(trx);
      return (await sql`select 1 from erasures where supporter_id = ${id}`.execute(trx)).rows;
    });
    expect(registered).toHaveLength(1);
  });

  it('erases a request whose job ran out of attempts at the next daily erasures.apply', async () => {
    const tenant = await newTenant('erase-sweep');
    const id = await signup(tenant);
    await invoker.run(useCases.eraseSupporter, eraser(tenant), { supporterId: id });
    // The job is spent: the worker no longer claims it, and nothing else would.
    await asRole(operatorDb, 'mycel_worker', (trx) =>
      sql`update jobs set attempts = max_attempts, failed_at = now(), last_error = 'lost'
        where tenant_id = ${tenant} and type = 'supporter.erase'`.execute(trx)
    );
    expect(
      await runJobs(operatorDb, handlers, { tenantId: tenant, types: ['supporter.erase'] })
    ).toMatchObject({ claimed: 0 });
    expect(await copies(tenant)).not.toEqual(none);

    sweepTenants = [tenant];
    await handlers['erasures.apply']!({
      id: uuidv7(),
      tenantId: null,
      type: 'erasures.apply',
      key: `erasures.apply:${run}`,
      runAt: clock.now(),
      payload: {},
      attempts: 1,
      maxAttempts: 10,
      claimedAt: clock.now(),
      doneAt: null,
      lastError: null,
      createdAt: clock.now(),
      failedAt: null,
    });
    expect(await copies(tenant)).toEqual(none);
  });
  // The daily job reads each tenant's own term and deletes as mycel_retention.
  it('retention.apply deletes a submission past the term its own tenant set, also when suspended', async () => {
    const months = (n: number) => monthsBefore(new Date(), n);
    // Thirteen months ago: past a twelve-month term, inside the default of twenty-four.
    const past = createUnitOfWork(appDb, { ...uowDeps, clock: { now: () => months(13) } });
    const submit = async (tenantId: string) => {
      const admin = systemPrincipal(tenantId, 'retention-job-test');
      const formId = uuidv7();
      await past.run(admin, (ctx) => ctx.forms.insert(probeForm(formId)));
      const submitted = await new Invoker(buildRegistry(), past).run(useCases.submitForm, admin, {
        formId,
        values: { email: address, consent: true },
        locale: 'nl',
      });
      if (submitted.status !== 'accepted') throw new Error(`submit ${submitted.status}`);
      await closeTenantWork(operatorDb, [tenantId]);
    };
    const shorter = await newTenant('retention-short');
    const standard = await newTenant('retention-default');
    for (const t of [shorter, standard]) await submit(t);
    await invoker.run(useCases.updateSiteRetention, systemPrincipal(shorter, 'test'), {
      baseVersion: 0,
      retention: { submissionMonths: 12 },
    });
    expect((await copies(shorter)).form_submissions).toBe(1);

    sweepTenants = [shorter, standard];
    const suspendedHandlers = jobHandlers({
      uow,
      operatorDb,
      identity: { tenantAccess: async () => ({ ...DEFAULT_ACCESS, status: 'suspended' }) },
      mail: { mailer: new MemoryMailer(), clock, sources: {} },
      tenantIds: async () => sweepTenants,
    });
    await suspendedHandlers['retention.apply']!({
      id: uuidv7(),
      tenantId: null,
      type: 'retention.apply',
      key: `retention.apply:${run}`,
      runAt: clock.now(),
      payload: {},
      attempts: 1,
      maxAttempts: 10,
      claimedAt: clock.now(),
      doneAt: null,
      lastError: null,
      createdAt: clock.now(),
      failedAt: null,
    });
    expect((await copies(shorter)).form_submissions).toBe(0);
    expect((await copies(standard)).form_submissions).toBe(1);
  });
});
