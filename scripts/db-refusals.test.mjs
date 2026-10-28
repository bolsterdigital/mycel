// A refusal is a domain rule, and domain rules live in packages/core (ADR 001, TODO #53 PR 4):
// core decides what a slug, a manifest or a status may be, so the memory adapter and Postgres
// refuse the same things with the same words. This ratchet keeps `new UseCaseError` in
// packages/db to the places below, each a fact only storage or the file system knows. A new one
// fails `npm run lint:infra` until its rule moves to core or it is listed here with its reason.
// Run offline.
// Rejected: a count without places (a rule could move in while another moves out unnoticed).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Per file, the refusals it may raise and why storage, not core, decides each. */
export const ALLOWED = {
  'packages/db/src/platform.ts': [
    'the hostname is already in use: only the read under mycel_platform knows',
    'a tenant with that slug exists: the insert under mycel_platform decides, races included',
  ],
  'packages/db/src/export.ts': [
    'the export target is not empty: a file-system fact, checked before anything is written',
    'no tenant with that slug to export: a read',
    'the imported tenant exists by id or slug: a read, before anything is written',
  ],
};
export const LIMIT = 5;

const PATTERN = /new\s+UseCaseError\s*\(/g;
const isTest = (name) => /\.test\.[cm]?[jt]s$/.test(name);

/** `[{ path, count }]` for every source file of `dir` (relative paths) that raises one. */
export function refusals(files) {
  return files
    .filter(({ path }) => !isTest(path))
    .map(({ path, text }) => {
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
      return { path, count: code.match(PATTERN)?.length ?? 0 };
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

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = 'packages/db/src';

function sources() {
  return readdirSync(join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.[cm]?ts$/.test(e.name))
    .map((e) => {
      const path = join(e.parentPath ?? e.path, e.name)
        .slice(root.length)
        .replace(/^\//, '');
      return { path, text: readFileSync(join(root, path), 'utf8') };
    });
}

test(`packages/db raises at most ${LIMIT} refusals, each in its listed place`, () => {
  const found = refusals(sources());
  assert.ok(
    found.some((f) => f.path === 'packages/db/src/platform.ts'),
    'the scan finds packages/db'
  );
  assert.deepEqual(overAllowance(found), []);
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
});
