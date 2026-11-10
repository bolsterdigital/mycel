// The consent snapshot backfill of migration 0020, run for real (TODO #22B, brief
// consent-confirmation § 1). The migrator applies 0020 once, on whatever submissions existed
// then, so this suite replays the SQL between the `backfill:begin` and `backfill:end` markers
// over submissions it inserts without the two columns, as before 0020, inside a transaction it
// rolls back. Two tenants with a form each: every row takes its own form's list and consent text
// version, and afterwards both columns are `not null` and RLS is forced again on both tables.
//
// Fixtures are written as a throwaway member of mycel_app under each tenant's context (since 0018
// the owner sees no tenant row); the replay runs as the owner, as the migrator does. Skips
// without DATABASE_URL; in CI that is a failure.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { probeForm, runSuffix } from '@mycel/core/testing';
import { uuidv7 } from './index.js';
import { requireDatabase, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl } = requireDatabase();

const MIGRATION = fileURLToPath(
  new URL('../migrations/0020_consent_snapshot.sql', import.meta.url)
);

describe.skipIf(skip)('migration 0020 backfill', () => {
  let backfill = '';
  // Each test owns its connections. A timed-out async body can still run its finally block;
  // sharing a client lets that cleanup race with the next test's transaction.
  const test = it.extend<{ replay: { client: pg.Client; holder: pg.Client; run: string } }>({
    replay: async ({}, use) => {
      const client = new pg.Client({ connectionString: operatorUrl });
      const holder = new pg.Client({ connectionString: operatorUrl });
      try {
        await client.connect();
        await holder.connect();
        await use({ client, holder, run: runSuffix() });
      } finally {
        // Closing the test-owned sessions rolls back any transaction left by a timeout.
        await Promise.all([client.end(), holder.end()]);
      }
    },
  });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const text = await readFile(MIGRATION, 'utf8');
    backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    expect(backfill).toContain('update form_submissions');
  });

  // Role membership locks precede table locks in every migration replay fixture. Holding
  // forms while waiting for mycel_app can deadlock with another fixture inserting a form.
  async function prepare(client: pg.Client, run: string, tenants: { id: string; key: string }[]) {
    await client.query('begin');
    try {
      const role = `snapshot_app_${run}`;
      await client.query(`create role ${role} nologin in role mycel_app`);
      // A non-superuser with CREATEROLE administers the new role but is not yet a member (16+).
      await client.query(`grant ${role} to current_user`);
      for (const t of tenants)
        await client.query(
          `insert into tenants (id, slug, name, default_locale, locales) values ($1, $2, $2, 'nl', '{nl}')`,
          [t.id, `snapshot-${t.key}-${run}`]
        );
      // Both tables at once, forms first, the order every other suite touches them in (a submit
      // reads the form, an export reads forms before submissions), and only after the tenant
      // rows: altering form_submissions first and forms later, or holding forms while inserting
      // a tenant, deadlocked with suites running beside this one on the same database (TODO #28
      // branch).
      await client.query('lock table forms, form_submissions in access exclusive mode');
      // The state before 0020: the columns exist but nothing fills them.
      await client.query(`alter table form_submissions alter column list drop not null,
                                                     alter column consent_text_version drop not null`);
      return role;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }

  test('waits for role membership before locking forms during a concurrent fixture', async ({
    replay,
  }) => {
    const { client, holder, run } = replay;
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0]!.pid;
    let preparing: Promise<string | Error> | undefined;
    try {
      await holder.query('begin');
      await holder.query(`create role snapshot_holder_${run} nologin in role mycel_app`);
      preparing = prepare(client, run, []).catch((error: Error) => error);
      // Synchronise on the actual role wait, not a sleep that can miss the interleaving.
      await expect
        .poll(async () => {
          const { rows } = await holder.query<{ blocked: boolean }>(
            'select pg_backend_pid() = any(pg_blocking_pids($1)) as blocked',
            [pid]
          );
          return rows[0]!.blocked;
        })
        .toBe(true);
      // The other fixture must still be able to touch forms while owning the role lock.
      // With table-first setup this fails with 55P03 and would complete the deadlock cycle.
      await holder.query("set local lock_timeout = '100ms'");
      await holder.query('lock table forms in access share mode');
      await holder.query('rollback');
      expect(await preparing).toBe(`snapshot_app_${run}`);
    } finally {
      await holder.query('rollback');
      if (preparing) await preparing;
      await client.query('rollback');
    }
  });

  test('fills every submission from its own form, for two tenants, and forces RLS again', async ({
    replay,
  }) => {
    const { client, run } = replay;
    const tenants = ['a', 'b'].map((key) => ({
      key,
      id: uuidv7(),
      form: { ...probeForm(uuidv7()), list: `list-${key}`, consentTextVersion: `text-${key}` },
      submissions: [uuidv7(), uuidv7()],
    }));
    const role = await prepare(client, run, tenants);
    try {
      await client.query(`set local role ${role}`);
      for (const t of tenants) {
        await client.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
        await client.query(`insert into forms (id, tenant_id, definition) values ($1, $2, $3)`, [
          t.form.id,
          t.id,
          JSON.stringify(t.form),
        ]);
        for (const id of t.submissions)
          await client.query(
            `insert into form_submissions (id, tenant_id, form_id, values, locale, created_at)
             values ($1, $2, $3, '{"email":"x@example.org","consent":true}', 'nl', now())`,
            [id, t.id, t.form.id]
          );
      }
      await client.query(`select set_config('app.tenant_id', '', true)`);
      await client.query('reset role');

      await client.query(backfill);

      await client.query(`set local role ${role}`);
      for (const t of tenants) {
        await client.query(`select set_config('app.tenant_id', $1, true)`, [t.id]);
        const { rows } = await client.query<{ list: string; consent_text_version: string }>(
          `select list, consent_text_version from form_submissions where id = any($1::uuid[])`,
          [t.submissions]
        );
        expect(rows, t.key).toEqual(
          t.submissions.map(() => ({
            list: t.form.list,
            consent_text_version: t.form.consentTextVersion,
          }))
        );
      }
      await client.query('reset role');
      const { rows: tables } = await client.query<{ relname: string; forced: boolean }>(
        `select relname, relforcerowsecurity as forced from pg_class
          where relname in ('forms', 'form_submissions') and relkind = 'r' order by relname`
      );
      expect(tables).toEqual([
        { relname: 'form_submissions', forced: true },
        { relname: 'forms', forced: true },
      ]);
      const { rows: columns } = await client.query<{ column_name: string; is_nullable: string }>(
        `select column_name, is_nullable from information_schema.columns
          where table_name = 'form_submissions' and column_name in ('list', 'consent_text_version')
          order by column_name`
      );
      expect(columns).toEqual([
        { column_name: 'consent_text_version', is_nullable: 'NO' },
        { column_name: 'list', is_nullable: 'NO' },
      ]);
    } finally {
      await client.query('rollback');
    }
  });
});
