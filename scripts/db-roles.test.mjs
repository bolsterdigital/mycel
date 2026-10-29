// A role switch is the route around RLS (ADR 002), and an advisory lock only serialises what
// takes the same key, so both live in one helper, `packages/db/src/roles.ts` (TODO #53): a
// closed list of roles and one key shape. This ratchet keeps every way to switch a role
// (`set [local|session] role`, `set_config('role', …)`, `reset role`, `set session
// authorization`) and every advisory lock (`pg_[try_]advisory[_xact]_lock`) out of every other
// source file of the packages and apps, tests and the e2e suite included: a test enters a role
// with `asRole`, `setRole`, `enterTenant` or, on a raw `pg` client, `setClientRole` (testing.md
// rule 3). The files named below may switch by hand, each with its reason: the suites that test
// the switch itself, and what a helper cannot express. Comments may name the statement. The same holds for the other way to change the platform: a
// tenant row is inserted only in `packages/db/src/platform.ts`, where every creation writes its
// audit row (TODO #74 removed `upsertTenant`, a second path without one). Run by
// `npm run lint:infra`, offline.
// Rejected: a grep in the workflow, which no test covers and which counts the comments too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTest,
  readAll,
  staleEntries,
  stripComments,
  walk,
  workspaceSources,
} from './lib/repo.mjs';

export const HELPER = 'packages/db/src/roles.ts';
const PATTERN =
  /set\s+(local\s+|session\s+)?role\b|set_config\(\s*'role'|reset\s+role|set\s+session\s+authorization|pg_(try_)?advisory(_xact)?_(un)?lock/i;

/**
 * Files that may switch a role or take a lock by hand, each with what it may write and why. The
 * list only shrinks (`unusedExceptions`).
 */
export const EXCEPTIONS = new Map([
  // A session-level lock on a raw `pg` client across many transactions (one migrator at a time),
  // which a transaction-scoped helper on Kysely cannot express.
  ['packages/db/src/migrate.ts', /pg_advisory_(un)?lock\(/i],
  // The suites that test the switch or the lock itself: every role against every policy, the
  // migration suites on a bare client at a past schema, the helper's own lock.
  ['packages/db/src/rls.conformance.test.ts', PATTERN],
  ['packages/db/src/content-migration.test.ts', PATTERN],
  ['packages/db/src/content-refs-migration.test.ts', PATTERN],
  ['packages/db/src/consent-snapshot-migration.test.ts', PATTERN],
  ['packages/db/src/roles.test.ts', /pg_try_advisory_xact_lock\(/i],
  // Proves that the authenticator login cannot switch to another role: the refused switch is
  // the assertion.
  ['packages/db/src/operators.test.ts', /set role mycel_worker/i],
  // Stands in for the backup login (backup.sh), which production never switches to, so it is
  // not a `DbRole`.
  ['packages/db/src/erasure-backups.test.ts', /set local role mycel_backup/i],
  // Back to the owner inside one rolled-back transaction, after inserting as mycel_app; the owner
  // is not a role to switch to.
  ['packages/db/src/jobs.test.ts', /reset role/i],
]);

/** Lines of code (comments stripped) in `files` (`[{ path, text }]`) that bypass the helper. */
export function bypasses(files) {
  return files.flatMap(({ path, text }) => {
    if (path === HELPER) return [];
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
// Any schema prefix, alias, column list or none, and `select`/`values` straight after the name;
// `tenant_hostnames` and other names that start with `tenants` stay out.
const TENANT_INSERT =
  /insertInto\(\s*['"](public\.)?tenants(\s+as\s+\w+)?['"]\s*\)|insert\s+into\s+("?public"?\.)?"?tenants"?(?=\s*\(|\s*`|\s*$|\s+(as|select|values|default|overriding|with)\b)/i;

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

/** The packages and apps, plus the e2e suite, which lives outside `src`. */
const sources = () => [
  ...workspaceSources(),
  ...readAll(walk('apps/web/e2e', { match: (p) => /\.[cm]?[jt]s$/.test(p) })),
];

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
  const found = workspaceSources();
  assert.ok(
    found.some((f) => f.path === PLATFORM && /insertInto\('tenants'\)/.test(f.text)),
    'the scan finds the platform insert'
  );
  assert.deepEqual(tenantInserts(found), []);
});

test('the tenant rule flags a second insert in any form and leaves platform.ts, tests and other tables', () => {
  const file = (path, text) => ({ path, text });
  assert.deepEqual(
    tenantInserts([
      file('packages/db/src/index.ts', "await trx.insertInto('tenants').values(row).execute();"),
      file('packages/db/src/seed.ts', 'await sql`insert into tenants (id, slug) values (1, 2)`;'),
      file('packages/db/src/a.ts', 'await sql`insert into public.tenants (id) values (1)`;'),
      file('packages/db/src/b.ts', 'await sql`insert into "public"."tenants" values (1)`;'),
      file('packages/db/src/c.ts', 'await sql`insert into tenants select * from old`;'),
      file('packages/db/src/d.ts', "await trx.insertInto('tenants as t').values(row).execute();"),
      file('packages/db/src/e.ts', "await trx.insertInto('public.tenants').values(row).execute();"),
      file('packages/db/src/f.ts', 'await sql`insert into tenants`;'),
      file('packages/db/src/g.ts', 'await sql`insert into tenants_archive (id) values (1)`;'),
      file(PLATFORM, "await trx.insertInto('tenants').values(row).execute();"),
      file('packages/db/src/x.test.ts', "await trx.insertInto('tenants').values(row).execute();"),
      file('packages/db/src/hostnames.ts', "await trx.insertInto('tenant_hostnames').values(r);"),
    ]),
    [
      "packages/db/src/index.ts:1: await trx.insertInto('tenants').values(row).execute();",
      'packages/db/src/seed.ts:1: await sql`insert into tenants (id, slug) values (1, 2)`;',
      'packages/db/src/a.ts:1: await sql`insert into public.tenants (id) values (1)`;',
      'packages/db/src/b.ts:1: await sql`insert into "public"."tenants" values (1)`;',
      'packages/db/src/c.ts:1: await sql`insert into tenants select * from old`;',
      "packages/db/src/d.ts:1: await trx.insertInto('tenants as t').values(row).execute();",
      "packages/db/src/e.ts:1: await trx.insertInto('public.tenants').values(row).execute();",
      'packages/db/src/f.ts:1: await sql`insert into tenants`;',
    ]
  );
});

test('the rule flags a hand-written switch or lock, in a test too, and leaves comments and the helper', () => {
  const file = (path, text) => ({ path, text });
  assert.deepEqual(
    bypasses([
      file('packages/db/src/jobs.ts', 'await sql`set local role mycel_worker`.execute(trx);'),
      file('packages/db/src/media.ts', 'await sql`select pg_advisory_xact_lock(1)`.execute(trx);'),
      file('packages/db/src/ops.ts', '// enters mycel_worker with `set local role`\nconst x = 1;'),
      file('packages/db/src/hostnames.ts', '/**\n * `set local role` once\n */\nconst y = 2;'),
      file('packages/db/src/media.test.ts', 'await sql`set local role mycel_app`.execute(trx);'),
      file('apps/web/e2e/admin.spec.ts', "await c.query('set local role mycel_worker');"),
      file(HELPER, 'await sql`set local role ${sql.id(role)}`.execute(trx);'),
    ]),
    [
      'packages/db/src/jobs.ts:1: await sql`set local role mycel_worker`.execute(trx);',
      'packages/db/src/media.ts:1: await sql`select pg_advisory_xact_lock(1)`.execute(trx);',
      'packages/db/src/media.test.ts:1: await sql`set local role mycel_app`.execute(trx);',
      "apps/web/e2e/admin.spec.ts:1: await c.query('set local role mycel_worker');",
    ]
  );
});

test('a test exception covers what it names and nothing else', () => {
  const jobs = 'packages/db/src/jobs.test.ts';
  assert.deepEqual(
    bypasses([
      { path: jobs, text: "await client.query('reset role');" },
      { path: jobs, text: "await client.query('set local role mycel_app');" },
    ]),
    [`${jobs}:1: await client.query('set local role mycel_app');`]
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
