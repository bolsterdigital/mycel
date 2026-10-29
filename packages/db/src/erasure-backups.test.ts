// Which erasure registrations a backup holds, against Postgres (TODO #29B, migration 0021; ADR 011,
// ADR 019 rule 8). The backup login records them after `restic backup` (docker/backup/backup.sh),
// `ctx.erasures.status()` reads them back per tenant, and nothing else can write them: mycel_app
// only reads its own tenant's rows, and the backup login can insert here and nowhere else.
// packages/core/src/supporters/erasure.test.ts holds the memory adapter to the same `status`.
//
// The backup login is made by the image's superuser (docker/postgres/init-backup-role.sh). As a
// superuser (CI, the dev stack) this suite makes it the same way when it is missing and enters it
// with `set local role`; an ordinary owner cannot, so on the Mac the suite skips, and in
// CI that is a failure. Skips without DATABASE_URL and APP_DATABASE_URL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { systemPrincipal } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  requireInCi,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, erasureStatus, uuidv7, uuidv7Ids } from './index.js';
import type { Database } from './schema.js';
import { requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const SNAPSHOT = 'ab'.repeat(32);

/**
 * Drop a scratch database once its pool has really gone. `db.destroy()` resolves when pg-pool has
 * removed its idle clients, not when their backends have exited; a `drop ... with (force)` in that
 * gap terminates a backend mid-shutdown and the 57P01 lands on a client with no error listener:
 * an unhandled error that fails the run with every test green (CI on 1e097cb). Rejected: an error
 * listener on the pool (would also hide a real connection loss elsewhere in the suite).
 */
async function dropDatabase(operatorDb: Kysely<Database>, name: string) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from pg_stat_activity where datname = ${name}`.execute(operatorDb);
    if (rows[0]?.n === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await sql`drop database if exists ${sql.id(name)} with (force)`.execute(operatorDb);
}

describe.skipIf(skip)('erasure backups conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const tenants: Record<'a' | 'b', string> = { a: '', b: '' };
  const erased: Record<'a' | 'b', string> = { a: uuidv7(), b: uuidv7() };
  let superuser = false;
  const second = { name: `mycel_erasure_backups_${run}`, url: '', canCreate: false };

  /** One transaction as the backup login, as backup.sh's `secure` runs. */
  const asBackup = <T>(fn: (trx: Kysely<Database>) => Promise<T>) =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_backup`.execute(trx);
      return fn(trx);
    });
  const record = (tenantId: string, supporterId: string) =>
    asBackup((trx) =>
      sql`insert into erasure_backups (tenant_id, supporter_id, snapshot_id)
          values (${tenantId}, ${supporterId}, ${SNAPSHOT}) on conflict do nothing`.execute(trx)
    );

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const { rows } = await sql<{ superuser: boolean; createdb: boolean }>`
      select rolsuper as superuser, rolsuper or rolcreatedb as createdb
      from pg_roles where rolname = current_user`.execute(operatorDb);
    superuser = rows[0]?.superuser === true;
    second.canCreate = rows[0]?.createdb === true;
    requireInCi(process.env, superuser, 'the login is no superuser, so it cannot be the backup');
    if (superuser) {
      // What init-backup-role.sh does on a box whose backup login comes after migration 0021.
      await sql`
        do $$ begin
          if not exists (select from pg_roles where rolname = 'mycel_backup') then
            create role mycel_backup nologin nosuperuser bypassrls;
          end if;
        end $$`.execute(operatorDb);
      await sql`grant pg_read_all_data to mycel_backup`.execute(operatorDb);
      await sql`grant insert on erasure_backups to mycel_backup`.execute(operatorDb);
    }
    for (const key of ['a', 'b'] as const) {
      tenants[key] = (
        await testTenant(operatorDb, `erabak-${key}-${run}`, { name: `Erasure backups ${key}` })
      ).id;
      await uow.run(systemPrincipal(tenants[key], 'erasure-backups-test'), (ctx) =>
        ctx.erasures.register(erased[key], `erabak-${key}-${run}@example.org`)
      );
    }
  });

  afterAll(async () => {
    if (second.url) await dropDatabase(operatorDb, second.name);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('reports a fresh registration as not secured, since when it was made', async () => {
    const status = await erasureStatus(operatorDb, tenants.a);
    expect(status).toMatchObject({ registered: 1, secured: 0 });
    expect(status.oldestUnsecuredAt).toBeInstanceOf(Date);
    expect(Date.now() - status.oldestUnsecuredAt!.getTime()).toBeLessThan(60_000);
  });

  it('counts a registration the backup recorded as secured, per tenant', async (ctx) => {
    if (!superuser) ctx.skip();
    await record(tenants.a, erased.a);
    await expect(erasureStatus(operatorDb, tenants.a)).resolves.toEqual({
      registered: 1,
      secured: 1,
      oldestUnsecuredAt: null,
    });
    // Tenant B's registration is untouched by A's record.
    await expect(erasureStatus(operatorDb, tenants.b)).resolves.toMatchObject({
      registered: 1,
      secured: 0,
    });
  });

  it('adds no second row when the same registration is recorded again', async (ctx) => {
    if (!superuser) ctx.skip();
    await record(tenants.a, erased.a);
    const { rows } = await asBackup((trx) =>
      sql<{ n: string }>`select count(*) as n from erasure_backups
                         where tenant_id = ${tenants.a}`.execute(trx)
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('refuses a record of a registration that does not exist', async (ctx) => {
    if (!superuser) ctx.skip();
    await expect(record(tenants.a, uuidv7())).rejects.toThrow(/foreign key/);
  });

  // That the backup login writes nothing else (not the register, not tenant data) is read from
  // its grants on every table in rls.conformance.test.ts, the one place for RLS bypass.

  it('lets mycel_app read its own records and write none', async (ctx) => {
    if (!superuser) ctx.skip();
    await record(tenants.b, erased.b);
    const inTenant = <T>(tenantId: string, fn: (trx: Kysely<Database>) => Promise<T>) =>
      appDb.transaction().execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${tenantId}, true)`.execute(trx);
        return fn(trx);
      });
    const seen = await inTenant(tenants.a, (trx) =>
      sql<{ tenant_id: string }>`select tenant_id from erasure_backups`.execute(trx)
    );
    expect(seen.rows.map((r) => r.tenant_id)).toEqual([tenants.a]);
    await expect(
      inTenant(tenants.a, (trx) =>
        sql`insert into erasure_backups (tenant_id, supporter_id, snapshot_id)
            values (${tenants.a}, ${erased.a}, ${SNAPSHOT})`.execute(trx)
      )
    ).rejects.toThrow(/permission denied/);
    await expect(
      inTenant(tenants.a, (trx) => sql`delete from erasure_backups`.execute(trx))
    ).rejects.toThrow(/permission denied/);
  });

  it('grants the insert where the backup login exists when 0021 runs (replay)', async (ctx) => {
    if (!superuser || !second.canCreate) ctx.skip();
    await sql`create database ${sql.id(second.name)}`.execute(operatorDb);
    const url = new URL(operatorUrl);
    url.pathname = `/${second.name}`;
    second.url = url.href;
    // Without passwords: the roles live in the cluster and already have theirs (TODO #27).
    await migrateSchema(second.url);
    const db = createDb(second.url);
    try {
      const { rows } = await sql<{ insert: boolean; update: boolean; remove: boolean }>`
        select has_table_privilege('mycel_backup', 'erasure_backups', 'insert') as insert,
               has_table_privilege('mycel_backup', 'erasure_backups', 'update') as update,
               has_table_privilege('mycel_backup', 'erasure_backups', 'delete') as remove`.execute(
        db
      );
      expect(rows[0]).toEqual({ insert: true, update: false, remove: false });
      const { rows: rls } = await sql<{ rls: boolean; forced: boolean }>`
        select relrowsecurity as rls, relforcerowsecurity as forced from pg_class
        where oid = 'public.erasure_backups'::regclass`.execute(db);
      expect(rls[0]).toEqual({ rls: true, forced: true });
    } finally {
      await db.destroy();
    }
  });
});
