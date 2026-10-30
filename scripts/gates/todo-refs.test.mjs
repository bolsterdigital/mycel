// References to the private planning board (`TODO #n`) in packages/ and apps/ only go down: each
// file against scripts/gates/todo-refs.baseline.json, and docs/adr, docs/architecture and the README hold
// none. A reader of this public repository cannot follow such a number; the constraint belongs in
// the comment and the history in git. Run by `npm run lint:infra`, offline.
// Rejected: one total (a removed reference and a new one elsewhere cancel out silently), and
// rewriting all of them at once (the replacement waits on a maintainer decision).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFiles, readJson, ROOT } from '../lib/repo.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASELINE = 'scripts/gates/todo-refs.baseline.json';
const REF = /TODO #\d/g;

/** `{ path: count }` of every file in `paths` with at least one reference. */
export function countRefs(paths, read) {
  const counts = {};
  for (const p of paths) {
    const n = (read(p).match(REF) ?? []).length;
    if (n) counts[p] = n;
  }
  return counts;
}

/** What grew past the baseline, and what shrank below it so the baseline can follow. */
export function ratchet(counts, baseline) {
  const grew = [];
  const shrank = [];
  for (const [p, n] of Object.entries(counts))
    if (n > (baseline[p] ?? 0)) grew.push(`${p}: ${n} (baseline ${baseline[p] ?? 0})`);
  for (const [p, n] of Object.entries(baseline))
    if ((counts[p] ?? 0) < n) shrank.push(`${p}: ${counts[p] ?? 0} (baseline ${n})`);
  return { grew, shrank };
}

const tracked = gitFiles() ?? [];
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

test('references to the private board in packages and apps only go down', () => {
  const paths = tracked.filter((p) => /^(packages|apps)\//.test(p));
  assert.ok(paths.length > 100, 'found the sources');
  const { grew, shrank } = ratchet(countRefs(paths, read), readJson(BASELINE));
  assert.deepEqual(grew, [], 'name the constraint instead of a private TODO number');
  assert.deepEqual(shrank, [], `fewer references: lower these entries in ${BASELINE}`);
});

test('ADRs, architecture docs and the README reference no private board item', () => {
  const paths = tracked.filter(
    (p) => /^docs\/(adr|architecture)\/.*\.md$/.test(p) || p === 'README.md'
  );
  assert.deepEqual(countRefs(paths, read), {});
});

test('a new reference and a removed one are both reported', () => {
  const counts = countRefs(
    ['a.ts', 'b.ts', 'c.ts'],
    (p) => ({ 'a.ts': '// TODO #1 and TODO #2', 'b.ts': 'none', 'c.ts': '// TODO #3' })[p]
  );
  assert.deepEqual(counts, { 'a.ts': 2, 'c.ts': 1 });
  assert.deepEqual(ratchet(counts, { 'a.ts': 1, 'c.ts': 2, 'd.ts': 1 }), {
    grew: ['a.ts: 2 (baseline 1)'],
    shrank: ['c.ts: 1 (baseline 2)', 'd.ts: 0 (baseline 1)'],
  });
});
