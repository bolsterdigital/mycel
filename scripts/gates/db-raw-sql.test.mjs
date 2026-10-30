// `sql.raw` and `sql.lit` put text into a statement without a parameter, so one with a value from
// a caller is an injection and one with a name from a caller reaches past RLS (ADR 002). Every
// other query builds on parameters, `sql.id` or `sql.ref`. This ratchet keeps the two to the
// places below in the source of the packages and apps, each with its reason; a new one fails
// `npm run lint:infra` until it is a parameter or listed here (TODO #74). Tests may still drop a
// table by name. Run offline.
// Rejected: a count without places (one could move in while another moves out unnoticed), and a
// lint rule in the workflow, which no test covers and which counts the comments too.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, staleEntries, stripComments, workspaceSources } from '../lib/repo.mjs';

/** Per file, the raw fragments it may build and why each takes no caller text. */
export const ALLOWED = {
  'packages/db/src/erasures.ts': [
    'hashOf: the erasure hash over an address expression, only one from HASHED',
    'TOMB: the tombstone domain, a constant from core',
    'carries: a carrier column, only one from CARRIER_COLUMNS',
  ],
};
export const LIMIT = 3;

const PATTERN = /\bsql\s*\.\s*(raw|lit)\s*\(/g;

/** `[{ path, count }]` for every source file (relative paths) that builds raw SQL. */
export function rawFragments(files) {
  return files
    .filter(({ path }) => !isTest(path))
    .map(({ path, text }) => ({ path, count: stripComments(text).match(PATTERN)?.length ?? 0 }))
    .filter(({ count }) => count > 0);
}

/** Files over their allowance, as messages. */
export function overAllowance(found, allowed = ALLOWED) {
  return found
    .filter(({ path, count }) => count > (allowed[path]?.length ?? 0))
    .map(
      ({ path, count }) =>
        `${path}: ${count} raw fragment(s), ${allowed[path]?.length ?? 0} allowed`
    );
}

/** Files that build fewer raw fragments than they are allowed: none, the list only shrinks. */
export function unusedAllowance(found, allowed = ALLOWED) {
  const counts = new Map(found.map(({ path, count }) => [path, count]));
  return staleEntries(
    Object.keys(allowed),
    (path) => (counts.get(path) ?? 0) >= allowed[path].length,
    'db-raw-sql ALLOWED'
  );
}

test(`the packages and apps build at most ${LIMIT} raw SQL fragments, each in its listed place`, () => {
  const found = workspaceSources();
  assert.ok(
    found.some((f) => f.path === 'packages/db/src/erasures.ts'),
    'the scan finds packages/db'
  );
  const raw = rawFragments(found);
  assert.deepEqual(overAllowance(raw), []);
  assert.deepEqual(unusedAllowance(raw), []);
  const total = raw.reduce((n, f) => n + f.count, 0);
  assert.ok(total <= LIMIT, `${total} raw fragments, limit ${LIMIT}`);
  assert.ok(
    Object.values(ALLOWED).flat().length <= LIMIT,
    'the allowance itself stays within the limit'
  );
});

test('the rule counts sql.raw and sql.lit in code, not comments or tests, and names the file', () => {
  const found = rawFragments([
    { path: 'packages/db/src/media.ts', text: 'const q = sql.raw(`drop ${name}`);' },
    { path: 'apps/web/src/lib/server/x.ts', text: 'const v = sql . lit(value);' },
    { path: 'packages/db/src/jobs.ts', text: '// `sql.raw(` never\nconst a = sql.id(name);' },
    { path: 'packages/db/src/jobs.test.ts', text: 'await sql.raw(`drop table x`).execute(db);' },
    {
      path: 'packages/db/src/erasures.ts',
      text: 'sql.raw(a);\nsql.raw(b);\nsql.raw(c);\nsql.lit(d);',
    },
  ]);
  assert.deepEqual(found, [
    { path: 'packages/db/src/media.ts', count: 1 },
    { path: 'apps/web/src/lib/server/x.ts', count: 1 },
    { path: 'packages/db/src/erasures.ts', count: 4 },
  ]);
  assert.deepEqual(overAllowance(found), [
    'packages/db/src/media.ts: 1 raw fragment(s), 0 allowed',
    'apps/web/src/lib/server/x.ts: 1 raw fragment(s), 0 allowed',
    'packages/db/src/erasures.ts: 4 raw fragment(s), 3 allowed',
  ]);
  assert.deepEqual(unusedAllowance([{ path: 'packages/db/src/erasures.ts', count: 2 }]), [
    'db-raw-sql ALLOWED: packages/db/src/erasures.ts is no longer needed; remove the entry',
  ]);
});
