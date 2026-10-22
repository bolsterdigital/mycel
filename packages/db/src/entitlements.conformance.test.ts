// Entitlements against Postgres (TODO #16): what the in-memory ports cannot prove. Who may read
// `tenants.entitlements` and `tenants.status` (mycel_app never, mycel_auth exactly the columns its
// lookups use), that a stored document reaches the Principal merged over the defaults through
// both pre-context paths, that usage counts one tenant, and what the platform functions refuse.
//
// Skips without DATABASE_URL, APP_DATABASE_URL and AUTH_DATABASE_URL; with E2E_REQUIRED=1 (CI)
// that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  ADMISSION_WINDOW_MS,
  DEFAULT_ENTITLEMENTS,
  Invoker,
  UseCaseError,
  buildRegistry,
  ingest,
  systemPrincipal,
  toSupporterEvent,
  useCases,
  withinLimit,
  type NewsletterSubscribedProps,
  type Principal,
} from '@mycel/core';
import { FakeDns, FakeSigner, memoryPlatform, probeForm } from '@mycel/core/testing';
import {
  createDb,
  createIdentityStore,
  createSiteDirectory,
  createTenant,
  createUnitOfWork,
  getTenant,
  listTenants,
  migrate,
  setEntitlements,
  setStatus,
  uuidv7,
  uuidv7Ids,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
const authUrl = process.env['AUTH_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl || !authUrl))
  throw new Error(
    'E2E_REQUIRED=1 but DATABASE_URL, APP_DATABASE_URL or AUTH_DATABASE_URL is unset'
  );

const DOMAIN = 'entitlements.test';

describe.skipIf(!operatorUrl || !appUrl || !authUrl)('entitlements conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const authDb = createDb(authUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const platform = {
    domain: DOMAIN,
    devHosts: [`dev-${run}.${DOMAIN}`],
    platformOrigin: `https://admin-${run}.${DOMAIN}`,
  };
  const unitOfWork = (now: () => Date = () => new Date()) =>
    createUnitOfWork(appDb, {
      clock: { now },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      dns: new FakeDns(),
      platform: { ...memoryPlatform, ...platform },
    });
  const uow = unitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const identity = createIdentityStore(authDb, uuidv7Ids);
  const sites = createSiteDirectory(authDb, { ttlMs: 0 });
  const create = (slug: string, entitlements?: Record<string, unknown>) =>
    createTenant(
      operatorDb,
      { id: uuidv7(), slug: `${slug}-${run}`, name: slug, locales: ['nl', 'en'], entitlements },
      platform
    );

  async function as<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const sqlState = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { code?: string }) => e.code
    );
  const code = (p: Promise<unknown>, expected: string) =>
    expect(p).rejects.toSatisfy((e) => e instanceof UseCaseError && e.code === expected);

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      appPassword: process.env['MYCEL_APP_PASSWORD'],
      authPassword: process.env['MYCEL_AUTH_PASSWORD'],
      log: () => {},
    });
  });

  afterAll(async () => {
    await Promise.all([operatorDb.destroy(), appDb.destroy(), authDb.destroy()]);
  });

  it('never shows entitlements or status to mycel_app, through the table or the view', async () => {
    const states = await as(appUrl!, async (c) => ({
      entitlements: await sqlState(c.query('select entitlements from tenants')),
      status: await sqlState(c.query('select status from tenants')),
      viewEntitlements: await sqlState(c.query('select entitlements from tenant_directory')),
    }));
    expect(states).toEqual({ entitlements: '42501', status: '42501', viewEntitlements: '42703' });
  });

  it('lets mycel_auth read exactly the columns its lookups use, and write nothing', async () => {
    const { rows } = await as(operatorUrl!, (c) =>
      c.query<{ column_name: string; privilege_type: string }>(
        `select column_name, privilege_type from information_schema.column_privileges
         where grantee = 'mycel_auth' and table_schema = 'public' and table_name = 'tenants'
         order by column_name`
      )
    );
    expect(rows).toEqual(
      ['default_locale', 'entitlements', 'id', 'locales', 'name', 'slug', 'status'].map((c) => ({
        column_name: c,
        privilege_type: 'SELECT',
      }))
    );
    const tried = await as(authUrl!, async (c) => {
      await c.query('begin');
      await c.query('set local role mycel_auth');
      const read = await sqlState(c.query('select id, entitlements, status from tenants limit 1'));
      await c.query('rollback');
      await c.query('begin');
      await c.query('set local role mycel_auth');
      const createdAt = await sqlState(c.query('select created_at from tenants limit 1'));
      await c.query('rollback');
      await c.query('begin');
      await c.query('set local role mycel_auth');
      const write = await sqlState(c.query(`update tenants set status = 'suspended'`));
      await c.query('rollback');
      return { read, createdAt, write };
    });
    expect(tried).toEqual({ read: 'ok', createdAt: '42501', write: '42501' });
  });

  /**
   * One statement as mycel_platform, entered from the authentication login like the API; with
   * `tenant`, under that tenant's context too, which must change nothing for this role.
   */
  const asPlatform = (statement: string, params: unknown[] = [], tenant?: string) =>
    as(authUrl!, async (c) => {
      await c.query('begin');
      await c.query('set local role mycel_platform');
      if (tenant) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      const state = await sqlState(c.query(statement, params));
      await c.query('rollback');
      return state;
    });

  it('gives mycel_platform no login, no superuser and no RLS bypass', async () => {
    const { rows } = await as(operatorUrl!, (c) =>
      c.query(
        `select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'mycel_platform'`
      )
    );
    expect(rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolbypassrls: false }]);
  });

  it('lets mycel_platform touch tenants and platform hostnames only, as the grants say', async () => {
    const a = await create('ent-pa');
    await create('ent-pb');
    // What the role may do: read hostnames across tenants.
    const { rows } = await as(authUrl!, async (c) => {
      await c.query('begin');
      await c.query('set local role mycel_platform');
      const r = await c.query<{ n: string }>(
        `select count(distinct tenant_id) as n from tenant_hostnames where hostname like $1`,
        [`ent-p_-${run}.${DOMAIN}`]
      );
      await c.query('rollback');
      return r;
    });
    expect(Number(rows[0]?.n)).toBe(2);

    // Nothing of a tenant's data, nothing of identity, no queues.
    for (const table of [
      'supporters',
      'events',
      'form_submissions',
      'api_keys',
      'tenant_memberships',
      'operators',
      'outbox',
      'jobs',
    ])
      expect(await asPlatform(`select count(*) from ${table}`), table).toBe('42501');
    // On tenants: no rename, no new slug, no delete.
    expect(await asPlatform(`update tenants set name = 'x' where id = $1`, [a.id])).toBe('42501');
    expect(await asPlatform(`update tenants set slug = 'x' where id = $1`, [a.id])).toBe('42501');
    expect(await asPlatform(`delete from tenants where id = $1`, [a.id])).toBe('42501');
    // A custom hostname is the tenant's own business (`tenant.hostnames.add`): RLS with check,
    // also under that tenant's context (`tenant_isolation` is mycel_app's alone since 0010).
    const custom = `insert into tenant_hostnames (hostname, tenant_id, kind, verification_token)
         values ($1, $2, 'custom', 't')`;
    expect(await asPlatform(custom, [`custom-${run}.example.org`, a.id])).toBe('42501');
    expect(await asPlatform(custom, [`custom-${run}.example.org`, a.id], a.id)).toBe('42501');
    // And a platform hostname is: the role's own policy, no context needed.
    expect(
      await asPlatform(
        `insert into tenant_hostnames (hostname, tenant_id, kind, verified_at)
         values ($1, $2, 'platform', now())`,
        [`ent-pa-two-${run}.${DOMAIN}`, a.id]
      )
    ).toBe('ok');
  });

  it('brings an empty and a partial document to the Principal, merged over the defaults', async () => {
    const empty = await create('ent-empty');
    const partial = await create('ent-part', { remove_branding: false, 'supporters.max': 250 });
    expect(await identity.tenantAccess(empty.id)).toEqual({
      entitlements: DEFAULT_ENTITLEMENTS,
      status: 'active',
    });
    const expected = {
      entitlements: { ...DEFAULT_ENTITLEMENTS, remove_branding: false, 'supporters.max': 250 },
      status: 'active',
    };
    expect(await identity.tenantAccess(partial.id)).toEqual(expected);
    expect((await sites.resolve(`ent-part-${run}.${DOMAIN}`))?.access).toEqual(expected);

    // A key a newer build wrote is ignored, not an error.
    await as(operatorUrl!, (c) =>
      c.query(`update tenants set entitlements = entitlements || '{"future.x": 1}' where id = $1`, [
        partial.id,
      ])
    );
    expect(await identity.tenantAccess(partial.id)).toEqual(expected);

    await setStatus(operatorDb, partial.id, 'suspended');
    expect((await identity.tenantAccess(partial.id)).status).toBe('suspended');
    expect((await sites.resolve(`ent-part-${run}.${DOMAIN}`))?.access.status).toBe('suspended');
  });

  it('counts usage for its own tenant only', async () => {
    const a = await create('ent-ua');
    const b = await create('ent-ub');
    const admin = (id: string) => systemPrincipal(id, 't');
    for (const [id, email] of [
      [a.id, 'one@example.org'],
      [a.id, 'two@example.org'],
      [b.id, 'three@example.org'],
    ] as const)
      await invoker.run(useCases.inviteMember, admin(id), {
        email: `${run}-${email}`,
        capabilities: ['content:read'],
      });
    await invoker.run(useCases.addHostname, admin(b.id), { hostname: `www-${run}.example.org` });
    const usage = await invoker.run(useCases.getUsage, admin(a.id), {});
    expect(usage).toMatchObject({
      supporters: { used: 0 },
      mail: { usedThisMonth: 0 },
      operators: { used: 2 },
      customDomains: { used: 0 },
    });
    expect((await invoker.run(useCases.getUsage, admin(b.id), {})).customDomains.used).toBe(1);
  });

  it('creates a tenant with its platform hostname under tenant context, and refuses collisions', async () => {
    const t = await create('ent-new', { api_keys: false });
    expect(t).toMatchObject({
      slug: `ent-new-${run}`,
      defaultLocale: 'nl',
      status: 'active',
      primaryHostname: `ent-new-${run}.${DOMAIN}`,
      storedEntitlements: { api_keys: false },
      entitlements: { ...DEFAULT_ENTITLEMENTS, api_keys: false },
    });
    expect((await sites.resolve(`ent-new-${run}.${DOMAIN}`))?.hostname).toMatchObject({
      kind: 'platform',
      primary: true,
    });
    expect((await listTenants(operatorDb)).map((x) => x.id)).toContain(t.id);

    await code(create('ent-new'), 'conflict');
    // The admin's own address and a development host are never a tenant's platform hostname.
    await code(
      createTenant(
        operatorDb,
        { id: uuidv7(), slug: `admin-${run}`, name: 'x', locales: ['nl'] },
        platform
      ),
      'conflict'
    );
    await code(
      createTenant(
        operatorDb,
        { id: uuidv7(), slug: `dev-${run}`, name: 'x', locales: ['nl'] },
        platform
      ),
      'conflict'
    );
    // A document with an unknown key is refused before anything is written.
    await code(create('ent-bad', { 'sites.max': 3 }), 'invalid_input');
  });

  it('refuses a slug whose platform hostname some tenant already holds', async () => {
    const holder = await create('ent-holder');
    const slug = `ent-taken-${run}`;
    await as(operatorUrl!, async (c) => {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [holder.id]);
      await c.query(
        `insert into tenant_hostnames (hostname, tenant_id, kind, verification_token)
         values ($1, $2, 'custom', 'legacy')`,
        [`${slug}.${DOMAIN}`, holder.id]
      );
      await c.query('commit');
    });
    await code(
      createTenant(operatorDb, { id: uuidv7(), slug, name: 'x', locales: ['nl'] }, platform),
      'conflict'
    );
  });

  it('stores what the hoster sends, validated, and answers null for an unknown tenant', async () => {
    const t = await create('ent-set');
    const set = await setEntitlements(operatorDb, t.id, { 'operators.max': 3 });
    expect(set).toMatchObject({
      storedEntitlements: { 'operators.max': 3 },
      entitlements: {
        'operators.max': 3,
        'supporters.max': DEFAULT_ENTITLEMENTS['supporters.max'],
      },
    });
    await code(setEntitlements(operatorDb, t.id, { 'operators.max': -1 }), 'invalid_input');
    await code(setEntitlements(operatorDb, t.id, { 'sites.max': 1 }), 'invalid_input');
    expect(await setEntitlements(operatorDb, uuidv7(), {})).toBeNull();
    expect(await setStatus(operatorDb, uuidv7(), 'suspended')).toBeNull();
    expect((await getTenant(operatorDb, t.id))?.storedEntitlements).toEqual({ 'operators.max': 3 });
  });

  // Review round 1, audit point 3: the supporter cap holds before the worker has ingested
  // anything, because `forms.submit` reserves a seat in its own transaction (`ctx.admissions`).
  describe('supporter admissions', () => {
    const capped = (tenantId: string, max: number): Principal => ({
      ...systemPrincipal(tenantId, 'admissions'),
      entitlements: { ...DEFAULT_ENTITLEMENTS, 'supporters.max': max },
    });
    /** What forms.submit does for a new address, without the rate limits around it. */
    const admit = (p: Principal, email: string, pause = 0) =>
      uow.run(p, async (ctx) => {
        await ctx.admissions.lock();
        if (await ctx.admissions.pending(email)) return;
        const n = await ctx.admissions.count();
        // Without the lock, both transactions would count the same free seat in this pause.
        await new Promise((r) => setTimeout(r, pause));
        withinLimit(ctx, 'supporters.max', n);
        await ctx.admissions.reserve(email);
      });
    /** Rows in the table for this tenant, expired ones included. */
    const rows = (tenantId: string) =>
      as(appUrl!, async (c) => {
        await c.query('begin');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        const { rows } = await c.query<{ n: string }>(
          'select count(*) as n from supporter_admissions'
        );
        await c.query('commit');
        return Number(rows[0]?.n);
      });

    it('gives two concurrent new addresses one free seat between them', async () => {
      const t = await create('adm-race');
      const p = capped(t.id, 1);
      const results = await Promise.allSettled([
        admit(p, 'a@example.org', 100),
        admit(p, 'b@example.org', 100),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(refused.reason).toMatchObject({ code: 'limit_exceeded' });
      expect(await rows(t.id)).toBe(1);
      expect(await uow.run(p, (ctx) => ctx.admissions.count())).toBe(1);
    });

    it('rolls a reservation back with the transaction that is refused', async () => {
      const t = await create('adm-roll');
      const p = capped(t.id, 0);
      await code(
        uow.run(p, async (ctx) => {
          await ctx.admissions.reserve('a@example.org');
          withinLimit(ctx, 'supporters.max', await ctx.admissions.count());
        }),
        'limit_exceeded'
      );
      expect(await rows(t.id)).toBe(0);

      // And through the use case: a refused signup leaves no seat behind.
      const formId = uuidv7();
      await uow.run(p, (ctx) => ctx.forms.insert(probeForm(formId)));
      await code(
        invoker.run(useCases.submitForm, p, {
          formId,
          values: { email: 'b@example.org', consent: true },
          locale: 'nl',
        }),
        'limit_exceeded'
      );
      expect(await rows(t.id)).toBe(0);
    });

    it('stops counting a reservation after the window and sweeps it on the next reserve', async () => {
      const t = await create('adm-old');
      const p = capped(t.id, 1);
      const past = unitOfWork(() => new Date(Date.now() - ADMISSION_WINDOW_MS - 24 * 3600_000));
      await past.run(p, (ctx) => ctx.admissions.reserve('old@example.org'));
      expect(await rows(t.id)).toBe(1);
      expect(await uow.run(p, (ctx) => ctx.admissions.count())).toBe(0);
      expect(await uow.run(p, (ctx) => ctx.admissions.pending('old@example.org'))).toBe(false);

      await admit(p, 'new@example.org');
      expect(await rows(t.id)).toBe(1);
      expect(await uow.run(p, (ctx) => ctx.admissions.pending('new@example.org'))).toBe(true);
    });

    it('releases the seat when ingest writes the projection, in one snapshot', async () => {
      const t = await create('adm-ingest');
      const p = capped(t.id, 1);
      const formId = uuidv7();
      await uow.run(p, (ctx) => ctx.forms.insert(probeForm(formId)));
      const submit = (email: string) =>
        invoker.run(useCases.submitForm, p, {
          formId,
          values: { email, consent: true },
          locale: 'nl',
        });
      expect((await submit('a@example.org')).status).toBe('accepted');
      await code(submit('b@example.org'), 'limit_exceeded');
      expect((await submit('a@example.org')).status).toBe('accepted');
      expect(await rows(t.id)).toBe(1);

      // What the ingest subscriber does for the outbox event, in one transaction.
      const props: NewsletterSubscribedProps = {
        email: 'a@example.org',
        list: 'newsletter',
        formId,
        submissionId: uuidv7(),
        locale: 'nl',
        pageUrl: null,
        consentTextVersion: 'v1',
        confirmed: false,
      };
      const event = await toSupporterEvent({
        id: uuidv7(),
        type: 'newsletter.subscribed',
        tenantId: t.id,
        occurredAt: new Date(),
        actor: { kind: 'system', job: 'test' },
        props: { ...props },
      });
      await uow.run(p, (ctx) => ingest(ctx, event));
      expect(await rows(t.id)).toBe(0);
      expect(
        await uow.run(p, async (ctx) => [
          await ctx.admissions.count(),
          await ctx.usage.supporters(),
        ])
      ).toEqual([1, 1]);
    });
  });
});
