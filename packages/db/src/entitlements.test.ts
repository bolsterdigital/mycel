// Entitlements against Postgres (TODO #16): what the in-memory ports cannot prove. Who may read
// `tenants.entitlements` and `tenants.status` (mycel_app never, mycel_auth exactly the columns its
// lookups use), that a stored document reaches the Principal merged over the defaults through
// both pre-context paths, that usage counts one tenant, and what the platform functions refuse.
//
// Skips without DATABASE_URL, APP_DATABASE_URL and AUTH_DATABASE_URL; in CI
// that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  ADMISSION_WINDOW_MS,
  DEFAULT_ENTITLEMENTS,
  Invoker,
  buildRegistry,
  ingest,
  toSupporterEvent,
  useCases,
  withinLimit,
  type NewsletterSubscribedProps,
  type Principal,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  adminOf,
  expectCode,
  memoryPlatform,
  principal,
  probeForm,
  runSuffix,
  testPlatformActor,
} from '@mycel/core/testing';
import {
  createDb,
  createIdentityStore,
  createSiteDirectory,
  createTenant,
  createUnitOfWork,
  ensureTenant,
  getTenant,
  listTenants,
  setEntitlements,
  setStatus,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from './index.js';
import { closeTenantWork, requireDatabase, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl, auth: authUrl } = requireDatabase('app', 'auth');

const DOMAIN = 'entitlements.test';

describe.skipIf(skip)('entitlements conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const authDb = createDb(authUrl);
  const run = runSuffix();
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
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: { ...memoryPlatform, ...platform },
    });
  const uow = unitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const identity = createIdentityStore(authDb, uuidv7Ids);
  const sites = createSiteDirectory(authDb, { ttlMs: 0 });
  const created: string[] = [];
  const create = async (slug: string, entitlements?: Record<string, unknown>) => {
    const t = await createTenant(
      operatorDb,
      { id: uuidv7(), slug: `${slug}-${run}`, name: slug, locales: ['nl', 'en'], entitlements },
      platform,
      testPlatformActor
    );
    created.push(t.id);
    return t;
  };

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

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, created);
    await Promise.all([operatorDb.destroy(), appDb.destroy(), authDb.destroy()]);
  });

  it('never shows entitlements or status to mycel_app, through the table or the view', async () => {
    const states = await as(appUrl, async (c) => ({
      entitlements: await sqlState(c.query('select entitlements from tenants')),
      status: await sqlState(c.query('select status from tenants')),
      viewEntitlements: await sqlState(c.query('select entitlements from tenant_directory')),
    }));
    expect(states).toEqual({ entitlements: '42501', status: '42501', viewEntitlements: '42703' });
  });

  it('lets mycel_auth read exactly the columns its lookups use, and write nothing', async () => {
    const { rows } = await as(operatorUrl, (c) =>
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
    const tried = await as(authUrl, async (c) => {
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
    as(authUrl, async (c) => {
      await c.query('begin');
      await c.query('set local role mycel_platform');
      if (tenant) await c.query(`select set_config('app.tenant_id', $1, true)`, [tenant]);
      const state = await sqlState(c.query(statement, params));
      await c.query('rollback');
      return state;
    });

  // RLS bypass for every role is held in one place, rls.conformance.test.ts.
  it('gives mycel_platform no login and no superuser', async () => {
    const { rows } = await as(operatorUrl, (c) =>
      c.query(`select rolcanlogin, rolsuper from pg_roles where rolname = 'mycel_platform'`)
    );
    expect(rows).toEqual([{ rolcanlogin: false, rolsuper: false }]);
  });

  it('lets mycel_platform touch tenants and platform hostnames only, as the grants say', async () => {
    const a = await create('ent-pa');
    await create('ent-pb');
    // What the role may do: read hostnames across tenants.
    const { rows } = await as(authUrl, async (c) => {
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
    // A custom hostname is the tenant's own business (`tenant.hostname.add`): RLS with check,
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
    await as(operatorUrl, (c) =>
      c.query(`update tenants set entitlements = entitlements || '{"future.x": 1}' where id = $1`, [
        partial.id,
      ])
    );
    expect(await identity.tenantAccess(partial.id)).toEqual(expected);

    await setStatus(operatorDb, partial.id, 'suspended', testPlatformActor);
    expect((await identity.tenantAccess(partial.id)).status).toBe('suspended');
    expect((await sites.resolve(`ent-part-${run}.${DOMAIN}`))?.access.status).toBe('suspended');
  });

  it('counts usage for its own tenant only', async () => {
    const a = await create('ent-ua');
    const b = await create('ent-ub');
    for (const [id, email] of [
      [a.id, 'one@example.org'],
      [a.id, 'two@example.org'],
      [b.id, 'three@example.org'],
    ] as const)
      await invoker.run(useCases.inviteMember, adminOf(id), {
        email: `${run}-${email}`,
        capabilities: ['content:read'],
      });
    await invoker.run(useCases.addHostname, adminOf(b.id), { hostname: `www-${run}.example.org` });
    const usage = await invoker.run(useCases.getUsage, adminOf(a.id), {});
    expect(usage).toMatchObject({
      supporters: { used: 0 },
      mail: { usedThisMonth: 0 },
      operators: { used: 2 },
      customDomains: { used: 0 },
    });
    expect((await invoker.run(useCases.getUsage, adminOf(b.id), {})).customDomains.used).toBe(1);
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

    await expectCode(create('ent-new'), 'conflict');
    // The admin's own address and a development host are never a tenant's platform hostname.
    await expectCode(
      createTenant(
        operatorDb,
        { id: uuidv7(), slug: `admin-${run}`, name: 'x', locales: ['nl'] },
        platform,
        testPlatformActor
      ),
      'conflict'
    );
    await expectCode(
      createTenant(
        operatorDb,
        { id: uuidv7(), slug: `dev-${run}`, name: 'x', locales: ['nl'] },
        platform,
        testPlatformActor
      ),
      'conflict'
    );
    // A document with an unknown key is refused before anything is written.
    await expectCode(create('ent-bad', { 'sites.max': 3 }), 'invalid_input');
  });

  it('ensures a tenant once, through createTenant and its audit row, and reuses it after', async () => {
    const slug = `ent-ensure-${run}`;
    const ensure = () =>
      ensureTenant(
        operatorDb,
        { id: uuidv7(), slug, name: 'Ensured', locales: ['nl', 'en'] },
        platform,
        testPlatformActor
      );
    const first = await ensure();
    created.push(first.id);
    const second = await ensure();
    expect(second).toEqual(first);
    const audit = await withTenant(appDb, adminOf(first.id), (trx) =>
      trx
        .selectFrom('audit_log')
        .select(['operation', 'actor_kind'])
        .where('subject_id', '=', first.id)
        .execute()
    );
    expect(audit).toEqual([{ operation: 'platform.tenant.create', actor_kind: 'platform' }]);
  });

  it('refuses a slug whose platform hostname some tenant already holds', async () => {
    const holder = await create('ent-holder');
    const slug = `ent-taken-${run}`;
    await as(operatorUrl, async (c) => {
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [holder.id]);
      // As mycel_app: since 0010 the policy on tenant_hostnames is bound to that role, so an
      // owner without superuser (managed Postgres, the Mac) cannot insert as itself.
      await c.query('set local role mycel_app');
      await c.query(
        `insert into tenant_hostnames (hostname, tenant_id, kind, verification_token)
         values ($1, $2, 'custom', 'legacy')`,
        [`${slug}.${DOMAIN}`, holder.id]
      );
      await c.query('commit');
    });
    await expectCode(
      createTenant(
        operatorDb,
        { id: uuidv7(), slug, name: 'x', locales: ['nl'] },
        platform,
        testPlatformActor
      ),
      'conflict'
    );
  });

  it('stores what the hoster sends, validated, and answers null for an unknown tenant', async () => {
    const t = await create('ent-set');
    const set = await setEntitlements(operatorDb, t.id, { 'operators.max': 3 }, testPlatformActor);
    expect(set).toMatchObject({
      storedEntitlements: { 'operators.max': 3 },
      entitlements: {
        'operators.max': 3,
        'supporters.max': DEFAULT_ENTITLEMENTS['supporters.max'],
      },
    });
    await expectCode(
      setEntitlements(operatorDb, t.id, { 'operators.max': -1 }, testPlatformActor),
      'invalid_input'
    );
    await expectCode(
      setEntitlements(operatorDb, t.id, { 'sites.max': 1 }, testPlatformActor),
      'invalid_input'
    );
    expect(await setEntitlements(operatorDb, uuidv7(), {}, testPlatformActor)).toBeNull();
    expect(await setStatus(operatorDb, uuidv7(), 'suspended', testPlatformActor)).toBeNull();
    expect((await getTenant(operatorDb, t.id))?.storedEntitlements).toEqual({ 'operators.max': 3 });
  });

  // Review round 1, audit point 3: the supporter cap holds before the worker has ingested
  // anything, because `form.submit` reserves a seat in its own transaction (`ctx.admissions`).
  describe('supporter admissions', () => {
    const capped = (tenantId: string, max: number): Principal =>
      principal({ tenantId, entitlements: { 'supporters.max': max } });
    /** What form.submit does for a new address, without the rate limits around it. */
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
      as(appUrl, async (c) => {
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
      await expectCode(
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
      await expectCode(
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
      // A second form: the same address on the same form is in its recipient cooldown for a day.
      const other = uuidv7();
      await uow.run(p, (ctx) => ctx.forms.insert(probeForm(formId)));
      await uow.run(p, (ctx) => ctx.forms.insert(probeForm(other)));
      const submit = (email: string, form = formId) =>
        invoker.run(useCases.submitForm, p, {
          formId: form,
          values: { email, consent: true },
          locale: 'nl',
        });
      expect((await submit('a@example.org')).status).toBe('accepted');
      await expectCode(submit('b@example.org'), 'limit_exceeded');
      expect((await submit('a@example.org', other)).status).toBe('accepted');
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
