// Operator erasure and the admin restore against Postgres (ADR 035 § Consequences).
// Operator X holds memberships on tenants A and B, made a key and a revision on each, and is the
// only admin of B; a pending invitation P waits on A; Y is the admin of A and C. Erasing X removes
// the account, both memberships and both keys in one go, leaves the revisions with X's id, writes
// one audit row per tenant, expires A's archive and says B has no admin left; Y, C and P are
// untouched until P is erased by its own id. A live session of X reaches no tenant and has no
// account; a later login with X's subject is a new account without memberships. A restored
// database that holds X again is erased again from the register. The admin restore repairs B and
// is refused where an admin exists, past `operators.max`, and for an unknown tenant. An archive
// round trip into a second database maps the history of a current member to the id their
// invitation gets there, and keeps an id that database erased anonymous.
// The restore drill (scripts/drill/drill-run.sh) proves the register through a real backup.
//
// Skips without DATABASE_URL, APP_DATABASE_URL and AUTH_DATABASE_URL; in CI that is a failure.
// The round trip needs CREATEDB, as export.conformance.test.ts does.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import {
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  type Capability,
  type Principal,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  expectCode,
  memoryPlatform,
  principal,
  requireInCi,
  runSuffix,
} from '@mycel/core/testing';
import {
  createDb,
  createIdentityStore,
  createUnitOfWork,
  eraseOperator,
  exportTenant,
  importTenant,
  reapplyOperatorErasures,
  restoreTenantAdmin,
  setEntitlements,
  uuidv7,
  uuidv7Ids,
} from './index.js';
import { enterTenant, setRole } from './infra/roles.js';
import type { Database } from './infra/schema.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl, auth: authUrl } = requireDatabase('app', 'auth');

const by = { actorId: 'erase-test', hasher: new FakeInputHasher() };
const ISSUER = 'https://idp.example.org';

/** Rows of one tenant, read as mycel_app in its context. */
async function inTenant<T>(
  db: Kysely<Database>,
  tenantId: string,
  fn: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await enterTenant(trx, tenantId);
    return fn(trx);
  });
}

describe.skipIf(skip)('operator erasure and admin restore (ADR 035)', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const authDb = createDb(authUrl);
  const identity = createIdentityStore(authDb, uuidv7Ids);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  const t = { a: '', b: '', c: '' };
  const made: string[] = [];
  const op = { x: '', y: '', p: '' };
  const addr = (who: string) => `${who}-${run}@example.org`;
  const as = (tenantId: string, operatorId: string, capabilities: Capability[]): Principal =>
    principal({ tenantId, actor: { kind: 'operator', operatorId }, capabilities });
  const invite = (tenantId: string, email: string, capabilities: Capability[]) =>
    invoker.run(useCases.inviteMember, systemPrincipal(tenantId, 'erase-test'), {
      email,
      capabilities,
    });
  const login = (who: string) =>
    identity.login({
      issuer: ISSUER,
      subject: `${who}-${run}`,
      email: addr(who),
      emailVerified: true,
    });
  const tenant = async (name: string) => {
    const created = await testTenant(operatorDb, `${name}-${run}`);
    made.push(created.id);
    return created.id;
  };
  const revision = async (p: Principal) =>
    (
      await invoker.run(useCases.createItem, p, {
        ...useCases.createItem.examples[0].input,
        slug: `erase-${runSuffix()}`,
      })
    ).revision.id;

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    t.a = await tenant('erase-a');
    t.b = await tenant('erase-b');
    t.c = await tenant('erase-c');
    await invite(t.a, addr('y'), ['tenant:admin']);
    await invite(t.c, addr('y'), ['tenant:admin']);
    await invite(t.a, addr('x'), ['tenant:admin']);
    await invite(t.b, addr('x'), ['tenant:admin']);
    op.p = (await invite(t.a, addr('p'), ['content:read'])).operatorId;
    op.x = (await login('x')).id;
    op.y = (await login('y')).id;
    for (const id of [t.a, t.b]) {
      const x = as(id, op.x, ['tenant:admin']);
      await invoker.run(useCases.createKey, x, { name: 'x key', capabilities: ['content:read'] });
      await revision(x);
    }
    await invoker.run(useCases.createKey, as(t.a, op.y, ['tenant:admin']), {
      name: 'y key',
      capabilities: ['content:read'],
    });
    // An archive of A, ready to download, made before the erasure.
    await inTenant(operatorDb, t.a, (trx) =>
      trx
        .insertInto('tenant_exports')
        .values({
          id: uuidv7(),
          tenant_id: t.a,
          requested_by: `operator:${op.y}`,
          status: 'ready',
          size_bytes: 1,
          sha256: '0'.repeat(64),
          expires_at: new Date(Date.now() + 86_400_000),
        })
        .execute()
    );
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, made);
    await Promise.all([operatorDb.destroy(), appDb.destroy(), authDb.destroy()]);
  });

  it('erases the account, its memberships and keys on every tenant, by id', async () => {
    expect((await identity.membershipsOf(op.x)).map((m) => m.tenantId).sort()).toEqual(
      [t.a, t.b].sort()
    );
    const result = await eraseOperator(operatorDb, op.x, by);
    expect(result).toMatchObject({ operatorId: op.x, alreadyRegistered: false, changed: true });
    expect(result.note).toMatch(/free text/);
    const byTenant = Object.fromEntries(result.tenants.map((r) => [r.tenantId, r]));
    expect(Object.keys(byTenant).sort()).toEqual([t.a, t.b].sort());
    expect(byTenant[t.a]).toMatchObject({ membership: true, revokedKeys: 1, expiredExports: 1 });
    expect(byTenant[t.a]!.withoutAdmin).toBe(false);
    expect(byTenant[t.b]).toMatchObject({ membership: true, revokedKeys: 1, withoutAdmin: true });

    // A live session reaches no tenant and has no account: the admin hook clears it.
    expect(await identity.membershipsOf(op.x)).toEqual([]);
    expect(await identity.accountOf(op.x)).toBeNull();
    // Y, C and the pending invitation are untouched.
    expect(await identity.accountOf(op.y)).not.toBeNull();
    expect((await identity.membershipsOf(op.y)).map((m) => m.tenantId).sort()).toEqual(
      [t.a, t.c].sort()
    );
    const pending = await inTenant(operatorDb, t.a, (trx) =>
      trx.selectFrom('tenant_memberships').select('operator_id').execute()
    );
    expect(pending.map((m) => m.operator_id).sort()).toEqual([op.p, op.y].sort());
  });

  it('keeps the id in history, shows a former team member, and leaves one audit row per tenant', async () => {
    for (const id of [t.a, t.b]) {
      const rows = await inTenant(operatorDb, id, async (trx) => ({
        actors: await trx.selectFrom('content_revisions').select('actor').execute(),
        keys: await trx
          .selectFrom('api_keys')
          .select(['name', 'revoked_at'])
          .where(sql<boolean>`created_by->>'operatorId' = ${op.x}`)
          .execute(),
        audit: await trx
          .selectFrom('audit_log')
          .select(['actor_kind', 'subject_id', 'effect'])
          .where('operation', '=', 'platform.operator.erase')
          .execute(),
      }));
      expect(rows.actors).toContainEqual({ actor: { kind: 'operator', operatorId: op.x } });
      expect(rows.keys).toHaveLength(1);
      expect(rows.keys[0]!.revoked_at).not.toBeNull();
      expect(rows.audit).toEqual([{ actor_kind: 'platform', subject_id: op.x, effect: 'erase' }]);
    }
    const { members } = await invoker.run(
      useCases.listMemberNames,
      as(t.a, op.y, ['tenant:admin']),
      {}
    );
    expect(members.map((m) => m.operatorId)).toEqual([op.y]);
    // C has no trace; Y's key on A still works.
    const c = await inTenant(operatorDb, t.c, (trx) =>
      trx.selectFrom('audit_log').select('id').where('subject_id', '=', op.x).execute()
    );
    expect(c).toEqual([]);
    const yKeys = await inTenant(operatorDb, t.a, (trx) =>
      trx
        .selectFrom('api_keys')
        .select('revoked_at')
        .where(sql<boolean>`created_by->>'operatorId' = ${op.y}`)
        .execute()
    );
    expect(yKeys).toEqual([{ revoked_at: null }]);
  });

  it('treats a second request as a no-op and refuses an id nobody knows', async () => {
    const again = await eraseOperator(operatorDb, op.x, by);
    expect(again).toMatchObject({ alreadyRegistered: true, changed: false, tenants: [] });
    await expectCode(eraseOperator(operatorDb, uuidv7(), by), 'not_found');
    const register = await operatorDb
      .selectFrom('operator_erasures')
      .select('operator_id')
      .where('operator_id', '=', op.x)
      .execute();
    expect(register).toHaveLength(1);
  });

  it('erases a pending invitation by its id', async () => {
    const result = await eraseOperator(operatorDb, op.p, by);
    expect(result.tenants.map((r) => [r.tenantId, r.membership])).toEqual([[t.a, true]]);
    const left = await operatorDb
      .selectFrom('operators')
      .select('id')
      .where('id', '=', op.p)
      .execute();
    expect(left).toEqual([]);
  });

  it('makes a later login with the old subject a new account without memberships', async () => {
    const again = await login('x');
    expect(again.id).not.toBe(op.x);
    expect(await identity.membershipsOf(again.id)).toEqual([]);
  });

  it('erases a registered operator again when a restore brought the account back', async () => {
    // What a restore of a backup from before the erasure holds: the account and a membership.
    await operatorDb
      .insertInto('operators')
      .values({ id: op.x, email: addr('x-restored') })
      .execute();
    await operatorDb.transaction().execute(async (trx) => {
      await setRole(trx, 'mycel_platform');
      await sql`select set_config('app.tenant_id', ${t.b}, true)`.execute(trx);
      await trx
        .insertInto('tenant_memberships')
        .values({
          tenant_id: t.b,
          operator_id: op.x,
          capabilities: ['content:read'],
          created_at: new Date(),
        })
        .execute();
    });
    const results = await reapplyOperatorErasures(operatorDb, by);
    expect(results.map((r) => r.operatorId)).toContain(op.x);
    expect(await identity.accountOf(op.x)).toBeNull();
    expect(await identity.membershipsOf(op.x)).toEqual([]);
    expect((await reapplyOperatorErasures(operatorDb, by)).map((r) => r.operatorId)).not.toContain(
      op.x
    );
  });

  it('restores an admin only on a tenant without one, within operators.max', async () => {
    await expectCode(restoreTenantAdmin(operatorDb, t.a, addr('new'), by), 'conflict');
    const restored = await restoreTenantAdmin(operatorDb, t.b, addr('successor'), by);
    expect(restored).toMatchObject({
      tenantId: t.b,
      kind: 'invite',
      capabilities: ['tenant:admin'],
    });
    await expectCode(restoreTenantAdmin(operatorDb, t.b, addr('other'), by), 'conflict');
    const audit = await inTenant(operatorDb, t.b, (trx) =>
      trx
        .selectFrom('audit_log')
        .select(['actor_kind', 'subject_id'])
        .where('operation', '=', 'platform.tenant.admin_restore')
        .execute()
    );
    expect(audit).toEqual([{ actor_kind: 'platform', subject_id: restored!.operatorId }]);
    expect(await restoreTenantAdmin(operatorDb, uuidv7(), addr('nobody'), by)).toBeNull();

    // An existing member without the capability gets it added, nothing else changes.
    const d = await tenant('erase-d');
    const member = await invite(d, addr('z'), ['content:write']);
    const granted = await restoreTenantAdmin(operatorDb, d, addr('z'), by);
    expect(granted).toMatchObject({ kind: 'grant', operatorId: member.operatorId });
    expect(granted!.capabilities.sort()).toEqual(['content:write', 'tenant:admin']);

    // A full site gets no new invitation.
    const e = await tenant('erase-e');
    await invite(e, addr('w'), ['content:read']);
    await setEntitlements(operatorDb, e, { 'operators.max': 1 }, by);
    await expectCode(restoreTenantAdmin(operatorDb, e, addr('v'), by), 'limit_exceeded');
  });

  it('maps the history of current members on import and keeps an erased id anonymous', async (ctx) => {
    const { rows } = await sql<{ ok: boolean }>`
      select rolsuper or rolcreatedb as ok from pg_roles where rolname = current_user`.execute(
      operatorDb
    );
    requireInCi(process.env, rows[0]?.ok === true, 'the login has neither CREATEDB nor superuser');
    if (!rows[0]?.ok) ctx.skip();
    const f = await tenant('erase-f');
    await invite(f, addr('m'), ['tenant:admin']);
    await invite(f, addr('gone'), ['content:write']);
    const m = (await login('m')).id;
    const gone = (await login('gone')).id;
    await revision(as(f, m, ['tenant:admin']));
    await revision(as(f, gone, ['content:write']));

    const dir = await mkdtemp(join(tmpdir(), 'mycel-erase-'));
    const name = `mycel_erase_${run}`;
    await sql`create database ${sql.id(name)}`.execute(operatorDb);
    const url = new URL(operatorUrl);
    url.pathname = `/${name}`;
    const target = createDb(url.href);
    try {
      await exportTenant({
        operatorDb,
        blobs: new MemoryBlobStore(),
        slug: `erase-f-${run}`,
        out: join(dir, 'f'),
        mycelVersion: 'test',
      });
      await migrateSchema(url.href);
      // The other installation erased `gone` earlier: its line stays out (ADR 035 rule 5).
      await target.insertInto('operator_erasures').values({ operator_id: gone }).execute();
      const report = await importTenant({
        operatorDb: target,
        blobs: new MemoryBlobStore(),
        path: join(dir, 'f'),
        platform: memoryPlatform,
        by,
      });
      expect(report.differences).toEqual([]);
      expect(report.lines).toContainEqual(
        'tenant_memberships: 1 imported, 1 skipped, erased on this installation'
      );
      const after = await inTenant(target, f, async (trx) => ({
        members: await trx.selectFrom('tenant_memberships').select('operator_id').execute(),
        actors: (await trx.selectFrom('content_revisions').select('actor').execute()).map(
          (r) => (r.actor as { operatorId: string }).operatorId
        ),
        audit: (
          await trx
            .selectFrom('audit_log')
            .select('actor_id')
            .where('actor_kind', '=', 'operator')
            .execute()
        ).map((r) => r.actor_id),
      }));
      expect(after.members).toHaveLength(1);
      const mapped = after.members[0]!.operator_id;
      expect(mapped).not.toBe(m);
      expect(after.actors.sort()).toEqual([mapped, gone].sort());
      expect(after.audit).toContain(mapped);
      expect(after.audit).not.toContain(m);
    } finally {
      await target.destroy();
      await rm(dir, { recursive: true, force: true });
      for (let i = 0; i < 50; i++) {
        const { rows: busy } = await sql<{ n: number }>`
          select count(*)::int as n from pg_stat_activity where datname = ${name}`.execute(
          operatorDb
        );
        if (busy[0]?.n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(operatorDb);
    }
  });
});
