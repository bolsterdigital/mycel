// The forward-only guarantee of docs/upgrading.md (TODO #18b): the runner records a sha256 per
// applied file and refuses to start when one has changed, before it applies or records anything.
// Runs `applyMigrations` over a temporary directory in a throwaway schema (`search_path`), so the
// real `schema_migrations` of the shared database is never touched and suites in parallel do not
// notice. Skips without DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, migrate } from './migrate.js';

const operatorUrl = process.env['DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && !operatorUrl)
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL is not set');

describe.skipIf(!operatorUrl)('migrate: checksums of applied files', () => {
  const client = new pg.Client({ connectionString: operatorUrl });
  const schema = `migrate_test_${Math.random().toString(36).slice(2, 8)}`;
  let dir = '';

  const write = (file: string, text: string) => writeFile(join(dir, file), text);
  const rows = async () =>
    (
      await client.query<{ version: string; checksum: string | null }>(
        'select version, checksum from schema_migrations order by version'
      )
    ).rows;

  beforeAll(async () => {
    dir = (await mkdtemp(join(tmpdir(), 'mycel-migrate-'))) + '/';
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}`);
  });

  afterAll(async () => {
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
    await rm(dir, { recursive: true, force: true });
  });

  it('records a sha256 per applied file and applies only what is new', async () => {
    await write('0001_a.sql', 'create table a (id int);');
    expect(await applyMigrations(client, dir)).toEqual(['0001_a']);
    const [first] = await rows();
    expect(first?.checksum).toMatch(/^[0-9a-f]{64}$/);

    await write('0002_b.sql', 'create table b (id int);');
    expect(await applyMigrations(client, dir)).toEqual(['0002_b']);
    expect(await applyMigrations(client, dir)).toEqual([]);
  });

  it('refuses a changed applied file before applying anything new', async () => {
    await write('0001_a.sql', 'create table a (id int, extra text);');
    await write('0003_c.sql', 'create table c (id int);');
    await expect(applyMigrations(client, dir)).rejects.toThrow(
      /applied migration\(s\) changed since they ran: 0001_a\.sql/
    );
    expect((await rows()).map((r) => r.version)).toEqual(['0001_a', '0002_b']);
    const { rows: c } = await client.query(
      `select 1 from information_schema.tables where table_schema = $1 and table_name = 'c'`,
      [schema]
    );
    expect(c).toHaveLength(0);

    await write('0001_a.sql', 'create table a (id int);');
    expect(await applyMigrations(client, dir)).toEqual(['0003_c']);
  });

  it('gives a row from before checksums the current file, then guards it', async () => {
    await client.query(`update schema_migrations set checksum = null where version = '0002_b'`);
    expect(await applyMigrations(client, dir)).toEqual([]);
    expect((await rows()).find((r) => r.version === '0002_b')?.checksum).toMatch(/^[0-9a-f]{64}$/);

    await write('0002_b.sql', 'create table b (id bigint);');
    await expect(applyMigrations(client, dir)).rejects.toThrow(/0002_b\.sql/);
    await write('0002_b.sql', 'create table b (id int);');
  });

  it('accepts a recorded version without a file (an image one release back)', async () => {
    await client.query(`insert into schema_migrations (version, checksum) values ('0099_z', 'x')`);
    expect(await applyMigrations(client, dir)).toEqual([]);
  });

  it('checks an already migrated schema without rewriting a cluster role', async () => {
    const { rows } = await client.query<{ name: string; superuser: boolean }>(
      `select current_user as name, rolsuper as superuser from pg_roles where rolname = current_user`
    );
    // An ordinary operator can change its own password, but not mycel_app's. The dev/CI
    // superuser exercises the exact application-role race; the Mac exercises the same catalog
    // tuple conflict on its own role without skipping the regression.
    const role = rows[0]?.superuser ? 'mycel_app' : rows[0]!.name;
    const quotedRole = `"${role.replaceAll('"', '""')}"`;
    const holder = new pg.Client({ connectionString: operatorUrl });
    const contender = new pg.Client({ connectionString: operatorUrl });
    await Promise.all([holder.connect(), contender.connect()]);
    try {
      await holder.query('begin');
      await holder.query(`alter role ${quotedRole} password 'rolled-back-test-value'`);
      // A second role update is the old conformance setup. It cannot finish while the first
      // transaction owns the catalog tuple; in full parallel runs it hit tuple concurrently updated.
      await contender.query(`set lock_timeout = '100ms'`);
      await expect(
        contender.query(`alter role ${quotedRole} password 'another-test-value'`)
      ).rejects.toMatchObject({ code: '55P03' });
      // The schema-only test setup can still finish while that role transaction is open.
      await expect(migrate(operatorUrl!, { log: () => {} })).resolves.toEqual([]);
    } finally {
      await holder.query('rollback').catch(() => {});
      await Promise.all([holder.end(), contender.end()]);
    }
  }, 30_000);
});
