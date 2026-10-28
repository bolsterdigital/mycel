// Operators, memberships and API keys against Postgres (TODO #7): what the in-memory store cannot
// prove. The database grants (mycel_app cannot link a subject and sees only its own tenant's
// operators), the least privilege of the two runtime logins, the login rules on real rows, two
// concurrent last-admin removals, and that no key outlives the membership that made it (#20a).
//
// Skips without DATABASE_URL, APP_DATABASE_URL and AUTH_DATABASE_URL; with E2E_REQUIRED=1 (CI)
// that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  Invoker,
  UseCaseError,
  activeKey,
  buildRegistry,
  hashApiKey,
  operatorPrincipal,
  systemPrincipal,
  useCases,
  type Principal,
} from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  createDb,
  createIdentityStore,
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

const ISSUER = 'https://idp.conformance.test';

describe.skipIf(!operatorUrl || !appUrl || !authUrl)('operator and key conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const authDb = createDb(authUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const identity = createIdentityStore(authDb, uuidv7Ids);
  const addr = (who: string) => `${who}-${run}@example.org`;
  const tenant = async (slug: string) =>
    (
      await upsertTenant(
        operatorDb,
        {
          id: uuidv7(),
          slug: `${slug}-${run}`,
          name: slug,
          defaultLocale: 'nl',
          locales: ['nl'],
        },
        { platformDomain: 'localhost' }
      )
    ).id;
  let a = '';
  let b = '';

  /** A plain client on one login, for statements the repositories would never issue. */
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
    await migrate(operatorUrl!, {
      log: () => {},
    });
    a = await tenant('opa');
    b = await tenant('opb');
  });

  afterAll(async () => {
    await Promise.all([operatorDb.destroy(), appDb.destroy(), authDb.destroy()]);
  });

  it('shows mycel_app the operators of its own tenant only', async () => {
    await invoker.run(useCases.inviteMember, systemPrincipal(a, 't'), {
      email: addr('only-a'),
      capabilities: ['content:read'],
    });
    await invoker.run(useCases.inviteMember, systemPrincipal(b, 't'), {
      email: addr('only-b'),
      capabilities: ['content:read'],
    });
    const visible = await as(appUrl!, async (c) => {
      const without = await c.query('select email from operators');
      await c.query('begin');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [a]);
      const within = await c.query<{ email: string }>('select email from operators');
      await c.query('commit');
      return { without: without.rowCount, within: within.rows.map((r) => r.email) };
    });
    expect(visible.without).toBe(0);
    expect(visible.within).toContain(addr('only-a'));
    expect(visible.within).not.toContain(addr('only-b'));
  });

  it('never lets mycel_app write operators or read their identity columns', async () => {
    const states = await as(appUrl!, async (c) => {
      const inTenant = async (statement: string, params: unknown[] = []) => {
        await c.query('begin');
        await c.query(`select set_config('app.tenant_id', $1, true)`, [a]);
        const state = await sqlState(c.query(statement, params));
        await c.query('rollback');
        return state;
      };
      return {
        link: await inTenant(`update operators set issuer = 'x', subject = 'y'`),
        insertLinked: await inTenant(
          `insert into operators (id, email, issuer, subject) values ($1, 'x@example.org', 'i', 's')`,
          [uuidv7()]
        ),
        insertPending: await inTenant(
          `insert into operators (id, email) values ($1, 'x@example.org')`,
          [uuidv7()]
        ),
        readSubject: await inTenant('select subject from operators'),
        inviteOutsideTenant: await sqlState(
          c.query('select operator_for_invite($1, $2)', ['x@example.org', uuidv7()])
        ),
      };
    });
    expect(states).toEqual({
      link: '42501',
      insertLinked: '42501',
      insertPending: '42501',
      readSubject: '42501',
      inviteOutsideTenant: '42501',
    });
  });

  it('gives the two runtime logins least privilege', async () => {
    const appUser = await as(
      appUrl!,
      async (c) => (await c.query('select current_user as u')).rows[0].u
    );
    const authUser = await as(
      authUrl!,
      async (c) => (await c.query('select current_user as u')).rows[0].u
    );
    expect([appUser, authUser]).toEqual(['mycel_app', 'mycel_authenticator']);

    const { rows } = await as(operatorUrl!, (c) =>
      c.query<{ role: string; flags: boolean[]; owns: number; table_rights: string[] }>(
        `select r.rolname as role,
                array[r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb] as flags,
                (select count(*)::int from pg_class c where c.relowner = r.oid) as owns,
                array(select c.relname::text from pg_class c
                      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v')
                        and has_table_privilege(r.oid, c.oid, 'select, insert, update, delete'))
                  as table_rights
         from pg_roles r where r.rolname = any($1)`,
        [[appUser, authUser]]
      )
    );
    for (const r of rows) {
      expect(r.flags, `${r.role}: superuser/bypassrls/createrole/createdb`).toEqual([
        false,
        false,
        false,
        false,
      ]);
      expect(r.owns, `${r.role} owns relations`).toBe(0);
    }
    // The authentication login has no table rights of its own: only through `set role`.
    expect(rows.find((r) => r.role === authUser)?.table_rights).toEqual([]);

    const roles = await as(operatorUrl!, (c) =>
      c.query<{ member: string; role: string; can_set: boolean; inherits: boolean }>(
        `select m.rolname as member, r.rolname as role,
                pg_has_role(m.oid, r.oid, 'SET') as can_set,
                pg_has_role(m.oid, r.oid, 'USAGE') as inherits
         from pg_roles m cross join pg_roles r
         where m.rolname = any($1)
           and r.rolname in ('mycel_auth', 'mycel_authenticator', 'mycel_worker', 'mycel_janitor',
                             'mycel_app', (select pg_get_userbyid(relowner) from pg_class
                                           where relname = 'operators'))
           and m.oid <> r.oid`,
        [[appUser, authUser]]
      )
    );
    const can = (member: string) =>
      roles.rows
        .filter((r) => r.member === member && (r.can_set || r.inherits))
        .map((r) => `${r.role}${r.inherits ? '+inherit' : ''}`);
    expect(can(appUser)).toEqual([]);
    expect(can(authUser)).toEqual(['mycel_auth']);

    // And in practice: nothing without the role switch, and no other role to switch to.
    const tried = await as(authUrl!, async (c) => ({
      direct: await sqlState(c.query('select count(*) from api_keys')),
      worker: await sqlState(c.query('set role mycel_worker')),
    }));
    expect(tried).toEqual({ direct: '42501', worker: '42501' });
  });

  it('links a pending invitation only to a login with a verified address', async () => {
    const invited = await invoker.run(useCases.inviteMember, systemPrincipal(a, 't'), {
      email: addr('pending'),
      capabilities: ['content:write'],
    });
    const unverified = await identity.login({
      issuer: ISSUER,
      subject: `u-${run}`,
      email: addr('pending').toUpperCase(),
      emailVerified: false,
    });
    expect(unverified.id).not.toBe(invited.operatorId);
    expect(unverified.emailVerifiedAt).toBeNull();
    expect(await identity.membershipsOf(unverified.id)).toEqual([]);

    const verified = await identity.login({
      issuer: ISSUER,
      subject: `v-${run}`,
      email: addr('pending'),
      emailVerified: true,
      name: 'Pending',
    });
    expect(verified).toMatchObject({ id: invited.operatorId, name: 'Pending' });
    expect(verified.emailVerifiedAt).not.toBeNull();
    expect(await identity.membershipsOf(verified.id)).toEqual([
      expect.objectContaining({ tenantId: a, capabilities: ['content:write'] }),
    ]);
    const listed = await invoker.run(useCases.listMembers, systemPrincipal(a, 't'), {});
    expect(listed.members.find((m) => m.operatorId === verified.id)).toMatchObject({
      pending: false,
      name: 'Pending',
    });
  });

  it('drops the verification when the address changes, and keys on (issuer, subject)', async () => {
    const subject = `move-${run}`;
    const first = await identity.login({
      issuer: ISSUER,
      subject,
      email: addr('before'),
      emailVerified: true,
    });
    const moved = await identity.login({
      issuer: ISSUER,
      subject,
      email: addr('after'),
      emailVerified: false,
    });
    expect(moved).toMatchObject({ id: first.id, email: addr('after'), emailVerifiedAt: null });
    const elsewhere = await identity.login({
      issuer: 'https://other.conformance.test',
      subject,
      email: addr('after'),
      emailVerified: true,
    });
    expect(elsewhere.id).not.toBe(first.id);
  });

  it('invites a verified operator by address, and refuses an address two of them share', async () => {
    const known = await identity.login({
      issuer: ISSUER,
      subject: `known-${run}`,
      email: addr('known'),
      emailVerified: true,
    });
    const m = await invoker.run(useCases.inviteMember, systemPrincipal(b, 't'), {
      email: addr('known'),
      capabilities: ['content:read'],
    });
    expect(m).toMatchObject({ operatorId: known.id, pending: false });

    for (const s of ['s1', 's2'])
      await identity.login({
        issuer: ISSUER,
        subject: `${s}-${run}`,
        email: addr('twice'),
        emailVerified: true,
      });
    await expect(
      invoker.run(useCases.inviteMember, systemPrincipal(b, 't'), {
        email: addr('twice'),
        capabilities: ['content:read'],
      })
    ).rejects.toSatisfy((e) => e instanceof UseCaseError && e.code === 'conflict');
  });

  it('finds keys by hash with their revocation, and touches last_used_at once a minute', async () => {
    const admin = systemPrincipal(a, 't');
    const { id, token } = await invoker.run(useCases.createKey, admin, {
      name: 'conformance',
      capabilities: ['content:read'],
    });
    const hash = await hashApiKey(token);
    expect(await identity.apiKeyByHash(hash)).toEqual({
      id,
      tenantId: a,
      capabilities: ['content:read'],
      revokedAt: null,
    });

    const t0 = new Date();
    await uow.run(admin, (ctx) => ctx.apiKeys.touch(id, t0));
    await uow.run(admin, (ctx) => ctx.apiKeys.touch(id, new Date(t0.getTime() + 30_000)));
    const lastUsed = async () =>
      (await invoker.run(useCases.listKeys, admin, {})).keys.find((k) => k.id === id)?.lastUsedAt;
    expect(await lastUsed()).toBe(t0.toISOString());
    const t1 = new Date(t0.getTime() + 61_000);
    await uow.run(admin, (ctx) => ctx.apiKeys.touch(id, t1));
    expect(await lastUsed()).toBe(t1.toISOString());

    await invoker.run(useCases.revokeKey, admin, { id });
    expect((await identity.apiKeyByHash(hash))?.revokedAt).toBeInstanceOf(Date);
    // Another tenant's admin cannot see or revoke it (RLS).
    await expect(
      invoker.run(useCases.revokeKey, systemPrincipal(b, 't'), { id })
    ).rejects.toSatisfy((e) => e instanceof UseCaseError && e.code === 'not_found');
  });

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Hold one tenant's writes from now until `ms` have passed. Wrapped, so awaiting the hold does
   * not also await its release. `memberships` share-locks the tenant's membership rows, which
   * stops a delete or update of them; `keys` locks the tenant row, which stops an insert into
   * `api_keys` at its foreign-key check. Row locks of the test's own tenant, not a table lock:
   * `lock table ... in share mode` also stalled every parallel suite writing memberships or keys
   * for the length of the hold (TODO #27, `Lock/relation` waits in the Mac measurement).
   */
  async function holdWrites(
    tenantId: string,
    what: 'memberships' | 'keys',
    ms: number
  ): Promise<{ released: Promise<void> }> {
    const blocker = new pg.Client({ connectionString: operatorUrl });
    await blocker.connect();
    await blocker.query('begin');
    // The operator login does not bypass forced RLS on the Mac. The tenant-row hold needs the
    // operator's UPDATE privilege, so only membership holds assume the application role.
    if (what === 'memberships') await blocker.query('set local role mycel_app');
    await blocker.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const { rowCount } = await blocker.query(
      what === 'memberships'
        ? 'select 1 from tenant_memberships where tenant_id = $1 for share'
        : 'select 1 from tenants where id = $1 for update',
      [tenantId]
    );
    // A hold on no rows holds nothing, and the race below would pass without being a race.
    expect(rowCount).toBeGreaterThan(0);
    return {
      released: pause(ms).then(async () => {
        await blocker.query('commit');
        await blocker.end();
      }),
    };
  }

  it('keeps one admin when the last two remove each other at the same moment', async () => {
    const c = await tenant('opc');
    const admins: { id: string; principal: Principal }[] = [];
    for (const who of ['x', 'y']) {
      const email = addr(`race-${who}`);
      await invoker.run(useCases.inviteMember, systemPrincipal(c, 't'), {
        email,
        capabilities: ['tenant:admin'],
      });
      const op = await identity.login({
        issuer: ISSUER,
        subject: `race-${who}-${run}`,
        email,
        emailVerified: true,
      });
      admins.push({
        id: op.id,
        principal: (await operatorPrincipal(identity, { operatorId: op.id, email }, c))!,
      });
    }
    const [x, y] = admins as [(typeof admins)[0], (typeof admins)[0]];
    // Make the race real: a share lock lets both transactions read the member list but holds
    // their deletes until both have read it. Without the membership lock both would then pass
    // the "an admin remains" check; with it the second waits and reads the first's result.
    const { released } = await holdWrites(c, 'memberships', 500);
    const racing = Promise.allSettled([
      invoker.run(useCases.removeMember, x.principal, { operatorId: y.id }),
      invoker.run(useCases.removeMember, y.principal, { operatorId: x.id }),
    ]);
    await released;
    const results = await racing;
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    // The second reads the first's result: it was just removed itself, so it no longer acts
    // (TODO #20a). Before #20a it answered `conflict` from the "an admin remains" check.
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'forbidden' });
    const left = await invoker.run(useCases.listMembers, systemPrincipal(c, 't'), {});
    expect(left.members.filter((m) => m.capabilities.includes('tenant:admin'))).toHaveLength(1);
  });
  // TODO #20a. The principal is loaded per request, outside the tenant transaction, so x may act
  // on rights y has just taken away. Three orders for each change: (a) y commits before x's
  // transaction starts; (b) x's createKey holds the membership lock and is stopped at its insert
  // while y's change starts; (c) y's change holds the lock and is stopped at its write while x
  // starts. The blocker is released on a timer, never after awaiting the side it holds: with the
  // lock in place that side may be the one the other waits for.
  describe('a key cannot outlive the membership that made it', () => {
    async function twoAdmins(tag: string) {
      const t = await tenant(`k${tag}`);
      const admins: { id: string; principal: Principal }[] = [];
      for (const who of ['x', 'y']) {
        const email = addr(`k${tag}-${who}`);
        await invoker.run(useCases.inviteMember, systemPrincipal(t, 't'), {
          email,
          capabilities: ['tenant:admin'],
        });
        const op = await identity.login({
          issuer: ISSUER,
          subject: `k${tag}-${who}-${run}`,
          email,
          emailVerified: true,
        });
        admins.push({
          id: op.id,
          principal: (await operatorPrincipal(identity, { operatorId: op.id, email }, t))!,
        });
      }
      const [x, y] = admins as [(typeof admins)[0], (typeof admins)[0]];
      return { t, x, y };
    }
    const changes = {
      removal: (y: Principal, x: string) =>
        invoker.run(useCases.removeMember, y, { operatorId: x }),
      demotion: (y: Principal, x: string) =>
        invoker.run(useCases.updateMember, y, { operatorId: x, capabilities: ['content:read'] }),
    };
    const createKey = (x: Principal) =>
      invoker.run(useCases.createKey, x, { name: 'race', capabilities: ['content:write'] }).then(
        (key) => ({ ok: true as const, key }),
        (e: unknown) => ({ ok: false as const, code: (e as UseCaseError).code })
      );

    for (const [name, change] of Object.entries(changes)) {
      it(`(a) refuses a stale principal after a ${name}`, async () => {
        const { x, y } = await twoAdmins(`a${name[0]}`);
        const changed = await change(y.principal, x.id);
        expect(changed.revokedKeys).toBe(0);
        expect(await createKey(x.principal)).toEqual({ ok: false, code: 'forbidden' });
      });

      it(`(b) a ${name} waiting for a key in flight revokes it`, async () => {
        const { t, x, y } = await twoAdmins(`b${name[0]}`);
        const { released } = await holdWrites(t, 'keys', 600);
        const creating = createKey(x.principal);
        await pause(200);
        const changing = change(y.principal, x.id);
        const [created, changed] = await Promise.all([creating, changing, released]);
        expect(created.ok).toBe(true);
        expect(changed.revokedKeys).toBe(1);
        expect(await activeKey(identity, created.ok ? created.key.token : '')).toBeNull();
      }, 15_000);

      it(`(c) refuses a key that waited for a ${name}`, async () => {
        const { t, x, y } = await twoAdmins(`c${name[0]}`);
        const { released } = await holdWrites(t, 'memberships', 600);
        const changing = change(y.principal, x.id);
        await pause(200);
        const creating = createKey(x.principal);
        const [changed, created] = await Promise.all([changing, creating, released]);
        expect(changed.revokedKeys).toBe(0);
        expect(created).toEqual({ ok: false, code: 'forbidden' });
      }, 15_000);
    }

    it('refuses a removed admin who invites themselves back or changes another member', async () => {
      const { x, y } = await twoAdmins('s');
      await changes.removal(y.principal, x.id);
      const code = (p: Promise<unknown>) =>
        p.then(
          () => 'ok',
          (e: UseCaseError) => e.code
        );
      expect(
        await code(
          invoker.run(useCases.inviteMember, x.principal, {
            email: addr('ks-x'),
            capabilities: ['tenant:admin'],
          })
        )
      ).toBe('forbidden');
      expect(
        await code(
          invoker.run(useCases.updateMember, x.principal, {
            operatorId: y.id,
            capabilities: ['content:read'],
          })
        )
      ).toBe('forbidden');
    });
  });
});
