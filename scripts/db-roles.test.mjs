// A role switch is the route around RLS (ADR 002), and an advisory lock only serialises what
// takes the same key, so both live in one helper, `packages/db/src/roles.ts` (TODO #53): a
// closed list of roles and one key shape. This ratchet keeps `set local role` and
// `pg_advisory_xact_lock` out of every other source file of the packages and apps. Tests may
// still switch roles by hand (testing.md, `set local role mycel_app` before an owner write), and
// comments may name the statement. Run by `npm run lint:infra`, offline.
// Rejected: a grep in the workflow, which no test covers and which counts the comments too.

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

export const HELPER = 'packages/db/src/roles.ts';
const PATTERN = /set\s+local\s+role|pg_advisory_xact_lock/i;
const isTest = (path) => /\.test\.[cm]?[jt]s$/.test(path);

/** Lines of code (comments stripped) in `files` (`[{ path, text }]`) that bypass the helper. */
export function bypasses(files) {
  return files.flatMap(({ path, text }) => {
    if (path === HELPER || isTest(path)) return [];
    const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '));
    return code.split('\n').flatMap((line, i) => {
      const bare = line.replace(/(^|[^:])\/\/.*$/, '$1');
      return PATTERN.test(bare) ? [`${path}:${i + 1}: ${line.trim()}`] : [];
    });
  });
}

const root = fileURLToPath(new URL('..', import.meta.url));

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return ['node_modules', 'dist', '.svelte-kit', 'build'].includes(entry.name)
        ? []
        : walk(path);
    return /\.[cm]?[jt]s$/.test(entry.name) ? [path] : [];
  });
}

function sources() {
  return ['packages', 'apps'].flatMap((top) =>
    readdirSync(join(root, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap(({ name }) => {
        try {
          return walk(join(root, top, name, 'src'));
        } catch {
          return [];
        }
      })
      .map((path) => ({ path: relative(root, path), text: readFileSync(path, 'utf8') }))
  );
}

test('role switches and advisory locks go through packages/db/src/roles.ts', () => {
  const found = sources();
  assert.ok(
    found.some((f) => f.path === HELPER),
    'the scan finds the helper'
  );
  assert.deepEqual(bypasses(found), []);
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
