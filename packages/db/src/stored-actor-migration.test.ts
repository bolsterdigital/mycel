// Migration 0053 run for real on its own SQL (ADR 035 rule 4, #224): the file removes the `email`
// key from every operator actor at rest and nothing else. The migrator applies it once, on
// whatever rows existed then, so this suite replays the file in a throwaway schema whose tables
// carry the same names and actor columns, with forced RLS like the real ones. A schema of its own
// means no lock on the shared tables, which suites beside this one use (the replay takes access
// exclusive locks on eleven of them). The real schema runs the same file in every `migrate`, and
// storage.conformance.test.ts proves the result there.
//
// Skips without DATABASE_URL; in CI that is a failure.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSuffix } from '@mycel/core/testing';
import { requireDatabase } from './testing.js';

const { skip, operator: operatorUrl } = requireDatabase();

const MIGRATION = fileURLToPath(
  new URL('../migrations/0053_stored_actor_ids.sql', import.meta.url)
);

/** Every table and actor column the migration names; `result` holds the actor at `result.actor`. */
const COLUMNS = {
  content_revisions: 'actor',
  content_bulk_plans: 'actor',
  content_bulk_effects: 'result',
  form_feed_settings: 'actor',
  connection_intents: 'actor',
  media: 'created_by',
  api_keys: 'created_by',
  erasures: 'actor',
  person_erasures: 'actor',
  outbox: 'actor',
  content_presence: 'actor',
} as const;

const OPERATOR = { kind: 'operator', operatorId: 'op-1', email: 'old@example.org', extra: 'kept' };
const KEY = { kind: 'api-key', keyId: 'key-1' };
/** Not an operator: an `email` key here is none of this migration's business. */
const OTHER = { kind: 'system', job: 'seed', email: 'not-an-operator@example.org' };

describe.skipIf(skip)('migration 0053: stored actors without an address', () => {
  const client = new pg.Client({ connectionString: operatorUrl });
  const schema = `stored_actor_${runSuffix()}`;

  beforeAll(async () => {
    await client.connect();
    await client.query(`create schema ${schema}`);
    await client.query(`set search_path to ${schema}`);
  });

  afterAll(async () => {
    await client.query(`drop schema if exists ${schema} cascade`);
    await client.end();
  });

  it('drops the address of every operator actor, touches nothing else, and forces RLS again', async () => {
    const wrap = (table: string, actor: object) =>
      table === 'content_bulk_effects' ? { status: 'changed', actor } : actor;
    for (const [table, column] of Object.entries(COLUMNS)) {
      await client.query(`create table ${table} (n int primary key, ${column} jsonb not null)`);
      for (const [n, actor] of [OPERATOR, KEY, OTHER].entries())
        await client.query(`insert into ${table} values ($1, $2)`, [
          n,
          JSON.stringify(wrap(table, actor)),
        ]);
      // As the real tables are: the owner sees nothing without unforcing first (0018).
      await client.query(`alter table ${table} enable row level security`);
      await client.query(`alter table ${table} force row level security`);
    }

    await client.query('begin');
    await client.query(await readFile(MIGRATION, 'utf8'));
    await client.query('commit');

    const { operatorId: _, email: __, ...rest } = OPERATOR;
    for (const [table, column] of Object.entries(COLUMNS)) {
      await client.query(`alter table ${table} no force row level security`);
      const { rows } = await client.query<{ v: unknown }>(
        `select ${column} as v from ${table} order by n`
      );
      expect(
        rows.map((r) => r.v),
        table
      ).toEqual([
        wrap(table, { ...rest, operatorId: OPERATOR.operatorId }),
        wrap(table, KEY),
        wrap(table, OTHER),
      ]);
      await client.query(`alter table ${table} force row level security`);
    }
    const { rows: forced } = await client.query<{ relname: string; f: boolean }>(
      `select relname, relforcerowsecurity as f from pg_class c join pg_namespace s
         on s.oid = c.relnamespace where s.nspname = $1 and relkind = 'r' order by relname`,
      [schema]
    );
    expect(forced.map((r) => r.relname)).toEqual(Object.keys(COLUMNS).sort());
    expect(forced.every((r) => r.f)).toBe(true);
  });
});
