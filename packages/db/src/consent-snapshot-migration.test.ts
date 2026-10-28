// The consent snapshot backfill of migration 0020, run for real (TODO #22B, brief
// consent-confirmation § 1). The migrator applies 0020 once, on whatever submissions existed
// then, so this suite replays the SQL between the `backfill:begin` and `backfill:end` markers
// over submissions it inserts without the two columns, as before 0020, inside a transaction it
// rolls back. Two tenants with a form each: every row takes its own form's list and consent text
// version, and afterwards both columns are `not null` and RLS is forced again on both tables.
//
// Fixtures are written as a throwaway member of mycel_app under each tenant's context (since 0018
// the owner sees no tenant row); the replay runs as the owner, as the migrator does. Skips
// without DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeForm } from '@mycel/core/testing';
import { migrate, uuidv7 } from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && !operatorUrl)
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL is not set');

const MIGRATION = fileURLToPath(
  new URL('../migrations/0020_consent_snapshot.sql', import.meta.url)
);

describe.skipIf(!operatorUrl)('migration 0020 backfill', () => {
  const client = new pg.Client({ connectionString: operatorUrl });
  let backfill = '';
  const run = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const text = await readFile(MIGRATION, 'utf8');
    backfill = text.slice(text.indexOf('-- backfill:begin'), text.indexOf('-- backfill:end'));
    expect(backfill).toContain('update form_submissions');
    await client.connect();
  });

  afterAll(() => client.end());

  it('fills every submission from its own form, for two tenants, and forces RLS again', async () => {
    const tenants = ['a', 'b'].map((key) => ({
      key,
      id: uuidv7(),
      form: { ...probeForm(uuidv7()), list: `list-${key}`, consentTextVersion: `text-${key}` },
      submissions: [uuidv7(), uuidv7()],
    }));
    await client.query('begin');
    try {
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
      const role = `snapshot_app_${run}`;
      await client.query(`create role ${role} nologin in role mycel_app`);
      // A non-superuser with CREATEROLE administers the new role but is not yet a member (16+).
      await client.query(`grant ${role} to current_user`);
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
