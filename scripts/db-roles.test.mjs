// A role switch is the route around RLS (ADR 002), and an advisory lock only serialises what
// takes the same key, so both live in one helper, `packages/db/src/roles.ts` (TODO #53): a
// closed list of roles and one key shape. This ratchet keeps every way to switch a role
// (`set [local|session] role`, `set_config('role', …)`, `reset role`, `set session
// authorization`) and every advisory lock (`pg_[try_]advisory[_xact]_lock`) out of every other
// source file of the packages and apps. One file is named below with its reason. Tests may still
// switch roles by hand (testing.md, `set local role mycel_app` before an owner write), and
// comments may name the statement. The same holds for the other way to change the platform: a
// tenant row is inserted only in `packages/db/src/platform.ts`, where every creation writes its
// audit row (TODO #74 removed `upsertTenant`, a second path without one). Run by
// `npm run lint:infra`, offline.
// Rejected: a grep in the workflow, which no test covers and which counts the comments too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, readAll, staleEntries, stripComments, walk } from './lib/repo.mjs';

export const HELPER = 'packages/db/src/roles.ts';
/**
 * Files that may take a lock by hand, each with its reason. `migrate.ts` holds a session-level
 * lock on a raw `pg` client across many transactions (one migrator at a time), which a
 * transaction-scoped helper on Kysely cannot express.
 */
export const EXCEPTIONS = new Map([['packages/db/src/migrate.ts', /pg_advisory_(un)?lock\(/i]]);
const PATTERN =
  /set\s+(local\s+|session\s+)?role\b|set_config\(\s*'role'|reset\s+role|set\s+session\s+authorization|pg_(try_)?advisory(_xact)?_(un)?lock/i;

/** Lines of code (comments stripped) in `files` (`[{ path, text }]`) that bypass the helper. */
export function bypasses(files) {
  return files.flatMap(({ path, text }) => {
    if (path === HELPER || isTest(path)) return [];
    const lines = text.split('\n');
    return stripComments(text)
      .split('\n')
      .flatMap((bare, i) => {
        if (!PATTERN.test(bare) || EXCEPTIONS.get(path)?.test(bare)) return [];
        return [`${path}:${i + 1}: ${lines[i].trim()}`];
      });
  });
}

export const PLATFORM = 'packages/db/src/platform.ts';
const TENANT_INSERT = /insertInto\(\s*['"]tenants['"]\s*\)|insert\s+into\s+"?tenants"?\s*\(/i;

/** Lines outside platform.ts (and tests) that insert a tenant row. */
export function tenantInserts(files) {
  return files.flatMap(({ path, text }) => {
    if (path === PLATFORM || isTest(path)) return [];
    const lines = text.split('\n');
    return stripComments(text)
      .split('\n')
      .flatMap((bare, i) =>
        TENANT_INSERT.test(bare) ? [`${path}:${i + 1}: ${lines[i].trim()}`] : []
      );
  });
}

/** Exceptions whose file no longer takes the lock they allow. */
export const unusedExceptions = (files) =>
  staleEntries(
    EXCEPTIONS.keys(),
    (path) => files.some((f) => f.path === path && EXCEPTIONS.get(path).test(f.text)),
    'db-roles EXCEPTIONS'
  );

const sources = () =>
  readAll(
    ['packages', 'apps'].flatMap((top) =>
      walk(top, {
        match: (p) => /^[^/]+\/[^/]+\/src\//.test(p) && /\.[cm]?[jt]s$/.test(p),
      })
    )
  );

test('role switches and advisory locks go through packages/db/src/roles.ts', () => {
  const found = sources();
  assert.ok(
    found.some((f) => f.path === HELPER),
    'the scan finds the helper'
  );
  assert.deepEqual(bypasses(found), []);
  assert.deepEqual(unusedExceptions(found), []);
});

test('a tenant row is inserted only in packages/db/src/platform.ts', () => {
  const found = sources();
  assert.ok(
    found.some((f) => f.path === PLATFORM && /insertInto\('tenants'\)/.test(f.text)),
    'the scan finds the platform insert'
  );
  assert.deepEqual(tenantInserts(found), []);
});

test('the tenant rule flags a second insert and leaves platform.ts, tests and tenant_hostnames', () => {
  const file = (path, text) => ({ path, text });
  assert.deepEqual(
    tenantInserts([
      file('packages/db/src/index.ts', "await trx.insertInto('tenants').values(row).execute();"),
      file('packages/db/src/seed.ts', 'await sql`insert into tenants (id, slug) values (1, 2)`;'),
      file(PLATFORM, "await trx.insertInto('tenants').values(row).execute();"),
      file('packages/db/src/x.test.ts', "await trx.insertInto('tenants').values(row).execute();"),
      file('packages/db/src/hostnames.ts', "await trx.insertInto('tenant_hostnames').values(r);"),
    ]),
    [
      "packages/db/src/index.ts:1: await trx.insertInto('tenants').values(row).execute();",
      'packages/db/src/seed.ts:1: await sql`insert into tenants (id, slug) values (1, 2)`;',
    ]
  );
});

test('the rule flags a hand-written switch or lock and leaves comments, tests and the helper', () => {
  const file = (path, text) => ({ path, text });
  assert.deepEqual(
    bypasses([
      file('packages/db/src/jobs.ts', 'await sql`set local role mycel_worker`.execute(trx);'),
      file('packages/db/src/media.ts', 'await sql`select pg_advisory_xact_lock(1)`.execute(trx);'),
      file('packages/db/src/ops.ts', '// enters mycel_worker with `set local role`\nconst x = 1;'),
      file('packages/db/src/hostnames.ts', '/**\n * `set local role` once\n */\nconst y = 2;'),
      file('packages/db/src/jobs.test.ts', 'await sql`set local role mycel_app`.execute(trx);'),
      file(HELPER, 'await sql`set local role ${sql.id(role)}`.execute(trx);'),
    ]),
    [
      'packages/db/src/jobs.ts:1: await sql`set local role mycel_worker`.execute(trx);',
      'packages/db/src/media.ts:1: await sql`select pg_advisory_xact_lock(1)`.execute(trx);',
    ]
  );
});

test('every form of role switch and advisory lock counts, one per line', () => {
  const forms = [
    'set role mycel_ops',
    'SET SESSION ROLE mycel_app',
    "select set_config('role', 'mycel_app', true)",
    'reset role',
    'set session authorization mycel',
    'select pg_advisory_lock(1)',
    'select pg_try_advisory_lock(1)',
    'select pg_try_advisory_xact_lock(1)',
    'select pg_advisory_unlock(1)',
  ];
  const files = forms.map((text, i) => ({ path: `packages/db/src/f${i}.ts`, text }));
  assert.deepEqual(
    bypasses(files),
    forms.map((text, i) => `packages/db/src/f${i}.ts:1: ${text}`)
  );
  // Not a switch: a column or setting that merely has `role` in its name.
  assert.deepEqual(
    bypasses([
      { path: 'packages/db/src/x.ts', text: "select role from members; set_config('app.role', x)" },
    ]),
    []
  );
});

test('the migrate exception covers its session lock and nothing else', () => {
  const migrate = 'packages/db/src/migrate.ts';
  assert.deepEqual(
    bypasses([
      { path: migrate, text: "await client.query('select pg_advisory_lock($1)', [KEY]);" },
      { path: migrate, text: "await client.query('select pg_advisory_unlock($1)', [KEY]);" },
    ]),
    []
  );
  assert.deepEqual(
    bypasses([{ path: migrate, text: 'await client.query(`set role mycel_ops`);' }]),
    [`${migrate}:1: await client.query(\`set role mycel_ops\`);`]
  );
});
