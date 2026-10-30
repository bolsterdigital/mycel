// A refusal is a domain rule, and domain rules live in packages/core (ADR 001, TODO #53 PR 4):
// core decides what a slug, a manifest or a status may be, so the memory adapter and Postgres
// refuse the same things with the same words. This ratchet keeps `new UseCaseError` in
// packages/db to the places below, each a fact only storage or the file system knows. A new one
// fails `npm run lint:infra` until its rule moves to core or it is listed here with its reason.
// Run offline.
// Rejected: a count without places (a rule could move in while another moves out unnoticed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, readAll, staleEntries, stripComments, walk } from '../lib/repo.mjs';

/** Per file, the refusals it may raise and why storage, not core, decides each. */
export const ALLOWED = {
  'packages/db/src/platform.ts': [
    'the hostname is already in use: only the read under mycel_platform knows',
    'a tenant with that slug exists: the insert under mycel_platform decides, races included',
  ],
  'packages/db/src/export.ts': [
    'the export target is not empty: a file-system fact, checked before anything is written',
  ],
};
export const LIMIT = 3;

const PATTERN = /new\s+UseCaseError\s*\(/g;

/** `[{ path, count }]` for every source file of `dir` (relative paths) that raises one. */
export function refusals(files) {
  return files
    .filter(({ path }) => !isTest(path))
    .map(({ path, text }) => {
      return { path, count: stripComments(text).match(PATTERN)?.length ?? 0 };
    })
    .filter(({ count }) => count > 0);
}

/** Files over their allowance, as messages. */
export function overAllowance(found, allowed = ALLOWED) {
  return found
    .filter(({ path, count }) => count > (allowed[path]?.length ?? 0))
    .map(
      ({ path, count }) => `${path}: ${count} refusal(s), ${allowed[path]?.length ?? 0} allowed`
    );
}

/** Files that may raise fewer refusals than they are allowed: none, the list only shrinks. */
export function unusedAllowance(found, allowed = ALLOWED) {
  const counts = new Map(found.map(({ path, count }) => [path, count]));
  return staleEntries(
    Object.keys(allowed),
    (path) => (counts.get(path) ?? 0) >= allowed[path].length,
    'db-refusals ALLOWED'
  );
}

const sources = () => readAll(walk('packages/db/src', { match: (p) => /\.[cm]?ts$/.test(p) }));

test(`packages/db raises at most ${LIMIT} refusals, each in its listed place`, () => {
  const found = refusals(sources());
  assert.ok(
    found.some((f) => f.path === 'packages/db/src/platform.ts'),
    'the scan finds packages/db'
  );
  assert.deepEqual(overAllowance(found), []);
  assert.deepEqual(unusedAllowance(found), []);
  const total = found.reduce((n, f) => n + f.count, 0);
  assert.ok(total <= LIMIT, `${total} refusals in packages/db, limit ${LIMIT}`);
  assert.ok(
    Object.values(ALLOWED).flat().length <= LIMIT,
    'the allowance itself stays within the limit'
  );
});

test('the rule counts code, not comments or tests, and names a file over its allowance', () => {
  const found = refusals([
    { path: 'packages/db/src/media.ts', text: "throw new UseCaseError('conflict', 'x');" },
    { path: 'packages/db/src/jobs.ts', text: '// throws new UseCaseError( never\nconst a = 1;' },
    { path: 'packages/db/src/media.test.ts', text: "new UseCaseError('conflict', 'x')" },
    {
      path: 'packages/db/src/platform.ts',
      text: "new UseCaseError('a', 'b');\nnew UseCaseError('c', 'd');\nnew UseCaseError('e', 'f');",
    },
  ]);
  assert.deepEqual(found, [
    { path: 'packages/db/src/media.ts', count: 1 },
    { path: 'packages/db/src/platform.ts', count: 3 },
  ]);
  assert.deepEqual(overAllowance(found), [
    'packages/db/src/media.ts: 1 refusal(s), 0 allowed',
    'packages/db/src/platform.ts: 3 refusal(s), 2 allowed',
  ]);
  assert.deepEqual(unusedAllowance(found), [
    'db-refusals ALLOWED: packages/db/src/export.ts is no longer needed; remove the entry',
  ]);
});
