// References to the private planning board (`TODO #n`, or a bare `#n` in a comment) in packages/,
// apps/, scripts/, docker/ and .github/ only go down: each file against
// scripts/gates/todo-refs.baseline.json, and docs/adr, docs/architecture and the README hold none. A reader of this public repository cannot follow such a number; the constraint belongs in
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
/**
 * A bare `#n` after a comment marker on its line. `PR #n` is a public number a reader can follow,
 * a colour or an anchor has no marker in front of it, and `&#n;` is an entity.
 */
const BARE = /(?:^\s*(?:\*|#)|\/\/|\/\*|<!--|\s#\s).*?(?<![\w&/#-])(?<!PRs? )(?<!TODO )#\d{1,3}\b/;
const bareRefs = (text) => text.split('\n').filter((line) => BARE.test(line)).length;

/** `{ path: count }` of every file in `paths` with at least one reference. */
export function countRefs(paths, read) {
  const counts = {};
  for (const p of paths) {
    const text = read(p);
    const n = (text.match(REF) ?? []).length + bareRefs(text);
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

test('references to the private board in code, scripts and workflows only go down', () => {
  const paths = tracked.filter((p) => /^(packages|apps|scripts|docker|\.github)\//.test(p));
  assert.ok(paths.length > 100, 'found the sources');
  const { grew, shrank } = ratchet(countRefs(paths, read), readJson(BASELINE));
  assert.deepEqual(grew, [], 'name the constraint instead of a private TODO number');
  assert.deepEqual(shrank, [], `fewer references: lower these entries in ${BASELINE}`);
});

test('ADRs, architecture docs and the README reference no private board item', () => {
  const paths = tracked.filter(
    (p) => /^docs\/(adr|architecture)\/.*\.md$/.test(p) || p === 'README.md'
  );
  // Prose has no comment marker to go by, so a bare number there is left to review.
  assert.deepEqual(
    paths.filter((p) => read(p).match(REF)),
    []
  );
});

test('a bare number counts in a comment, not as a public PR, a colour or an entity', () => {
  const count = (text) => countRefs(['a.ts'], () => text)['a.ts'] ?? 0;
  assert.equal(count('// the menu (#87) collapses'), 1);
  assert.equal(count('  * #51: a refusal is a code'), 1);
  assert.equal(count('<!-- see #12 -->'), 1);
  assert.equal(count('# the worker (#34) drains'), 1);
  assert.equal(count('// PR #28 and PRs #175'), 0);
  assert.equal(count("const color = '#123';"), 0);
  assert.equal(count('<a href="#12">&#39;</a>'), 0);
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
