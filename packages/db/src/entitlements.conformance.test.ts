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
  DEFAULT_ENTITLEMENTS,
  Invoker,
  UseCaseError,
  buildRegistry,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeDns, FakeSigner, memoryPlatform } from '@mycel/core/testing';
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
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    dns: new FakeDns(),
    platform: { ...memoryPlatform, ...platform },
  });
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
});
