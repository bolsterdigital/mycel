// Hostnames against Postgres (TODO #14): what the in-memory ports cannot prove. Isolation of
// `tenant_hostnames` under RLS, global uniqueness as a typed conflict, one primary per tenant,
// resolution through mycel_auth for every hostname while mycel_app sees its own only, the
// `tenant_directory` view as the only way mycel_app reads tenants, and the platform hostname
// `upsertTenant` makes exactly once.
//
// Skips without DATABASE_URL, APP_DATABASE_URL and AUTH_DATABASE_URL; with E2E_REQUIRED=1 (CI)
// that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Invoker, UseCaseError, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  createDb,
  createSiteDirectory,
  createTenantDirectory,
  createUnitOfWork,
  migrate,
  upsertTenant,
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

const PLATFORM = 'conformance.test';

describe.skipIf(!operatorUrl || !appUrl || !authUrl)('hostname conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const authDb = createDb(authUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const dns = new FakeDns();
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    dns,
    platform: { ...memoryPlatform, domain: PLATFORM },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  // No cache: every assertion below reads the database as it is.
  const sites = createSiteDirectory(authDb, { ttlMs: 0 });
  const host = (name: string) => `${name}-${run}.example.org`;
  const tenant = async (slug: string) =>
    upsertTenant(
      operatorDb,
      { id: uuidv7(), slug: `${slug}-${run}`, name: slug, defaultLocale: 'nl', locales: ['nl'] },
      { platformDomain: PLATFORM }
    );
  let a = '';
  let b = '';
  let slugA = '';

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
    const ta = await tenant('hna');
    a = ta.id;
    slugA = ta.slug;
    b = (await tenant('hnb')).id;
  });

  afterAll(async () => {
    await Promise.all([operatorDb.destroy(), appDb.destroy(), authDb.destroy()]);
  });

  it('gives a new tenant its platform hostname once: verified, primary, never duplicated', async () => {
    const listed = async () =>
      (await invoker.run(useCases.listHostnames, systemPrincipal(a, 't'), {})).hostnames;
    const first = await listed();
    expect(first).toEqual([
      {
        hostname: `${slugA}.${PLATFORM}`,
        kind: 'platform',
        primary: true,
        verifiedAt: expect.any(String),
        lastCheckedAt: null,
        checkFailures: 0,
      },
    ]);
    // A rerun of the seed changes nothing.
    await tenant('hna');
    expect(await listed()).toEqual(first);
    expect(await sites.allowed(`${slugA}.${PLATFORM}`)).toBe(true);
  });

  it('isolates hostnames per tenant and makes a taken name a conflict that names no owner', async () => {
    const admin = systemPrincipal(a, 't');
    const added = await invoker.run(useCases.addHostname, admin, { hostname: host('www') });
    expect(added.dns?.cname.target).toBe(`${slugA}.${PLATFORM}`);
    await code(
      invoker.run(useCases.addHostname, systemPrincipal(b, 't'), { hostname: host('WWW') }),
      'conflict'
    );
    const ofB = await invoker.run(useCases.listHostnames, systemPrincipal(b, 't'), {});
    expect(ofB.hostnames.map((h) => h.kind)).toEqual(['platform']);
    await code(
      invoker.run(useCases.verifyHostname, systemPrincipal(b, 't'), { hostname: host('www') }),
      'not_found'
    );
    // Straight SQL as mycel_app: nothing without a context, own rows with one.
    const seen = await as(appUrl!, async (c) => {
      const without = await c.query('select hostname from tenant_hostnames');
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [b]);
      const within = await c.query<{ hostname: string }>('select hostname from tenant_hostnames');
      await c.query('commit');
      return { without: without.rowCount, within: within.rows.map((r) => r.hostname) };
    });
    expect(seen.without).toBe(0);
    expect(seen.within).toEqual([`hnb-${run}.${PLATFORM}`]);
  });

  it('keeps exactly one primary per tenant, also against a direct update', async () => {
    const admin = systemPrincipal(a, 't');
    const name = host('primary');
    const added = await invoker.run(useCases.addHostname, admin, { hostname: name });
    dns.txtRecords.set(added.dns!.txt.name, [added.dns!.txt.value]);
    await code(invoker.run(useCases.setPrimaryHostname, admin, { hostname: name }), 'conflict');
    expect(await invoker.run(useCases.verifyHostname, admin, { hostname: name })).toMatchObject({
      verified: true,
    });
    await invoker.run(useCases.setPrimaryHostname, admin, { hostname: name });
    const primaries = (await invoker.run(useCases.listHostnames, admin, {})).hostnames.filter(
      (h) => h.primary
    );
    expect(primaries.map((h) => h.hostname)).toEqual([name]);
    // The partial unique index refuses a second primary even outside the use case.
    const state = await as(appUrl!, async (c) => {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [a]);
      const s = await sqlState(
        c.query('update tenant_hostnames set is_primary = true where hostname = $1', [
          `${slugA}.${PLATFORM}`,
        ])
      );
      await c.query('rollback');
      return s;
    });
    expect(state).toBe('23505');
    expect((await sites.resolve(`${slugA}.${PLATFORM}`))?.hostname.primary).toBe(false);
    await invoker.run(useCases.setPrimaryHostname, admin, { hostname: `${slugA}.${PLATFORM}` });
    await invoker.run(useCases.removeHostname, admin, { hostname: name });
    expect(await sites.resolve(name)).toBeNull();
  });

  it('resolves every hostname as mycel_auth, verified or not, and nothing unknown', async () => {
    const admin = systemPrincipal(a, 't');
    const name = host('unverified');
    await invoker.run(useCases.addHostname, admin, { hostname: name });
    const found = await sites.resolve(name);
    expect(found).toMatchObject({
      tenant: { id: a, slug: slugA },
      hostname: { hostname: name, kind: 'custom', primary: false, verifiedAt: null },
    });
    expect(await sites.allowed(name)).toBe(false);
    expect(await sites.resolve(`nope-${run}.example.org`)).toBeNull();
    // The authentication login reaches the table only through the role switch.
    expect(
      await as(authUrl!, (c) => sqlState(c.query('select count(*) from tenant_hostnames')))
    ).toBe('42501');
  });

  it('serves the cached answer for the TTL and forgets it on invalidate', async () => {
    let t = 0;
    const cached = createSiteDirectory(authDb, { ttlMs: 1000, now: () => t });
    const admin = systemPrincipal(a, 't');
    const name = host('cached');
    expect(await cached.resolve(name)).toBeNull();
    await invoker.run(useCases.addHostname, admin, { hostname: name });
    expect(await cached.resolve(name)).toBeNull();
    t = 1000;
    expect((await cached.resolve(name))?.tenant.id).toBe(a);
    await invoker.run(useCases.removeHostname, admin, { hostname: name });
    expect((await cached.resolve(name))?.tenant.id).toBe(a);
    cached.invalidate(name);
    expect(await cached.resolve(name)).toBeNull();
  });

  it('lets mycel_app read tenants only through the five-column directory view', async () => {
    const states = await as(appUrl!, async (c) => ({
      table: await sqlState(c.query('select id from tenants')),
      view: await sqlState(c.query('select id from tenant_directory')),
    }));
    expect(states).toEqual({ table: '42501', view: 'ok' });
    const { rows } = await as(operatorUrl!, (c) =>
      c.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_schema = 'public' and table_name = 'tenant_directory' order by ordinal_position`
      )
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'id',
      'slug',
      'name',
      'default_locale',
      'locales',
    ]);
    const directory = createTenantDirectory(appDb);
    expect(await directory.findById(a)).toMatchObject({ id: a, slug: slugA, name: 'hna' });
    expect(await directory.findBySlug(slugA)).toMatchObject({ id: a });
  });
});
