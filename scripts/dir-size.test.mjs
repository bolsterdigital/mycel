// No tracked directory holds more than 15 loose non-test files, and the directories that already
// do only shrink: each against its ceiling in scripts/dir-size.baseline.json. A flat directory of
// thirty modules hides which ones belong together; past fifteen a reader scans instead of finds.
// Numbered or one-per-kind directories (migrations, ADRs, one file per block type) are exempt in
// the same baseline, each with its reason. Run by `npm run lint:infra`, offline.
// Rejected: a limit on all files including tests (it punishes colocated tests, which this
// repository wants) and one repository-wide total (a split in one place hides growth in another).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { posix } from 'node:path';
import { gitFiles, isTest, readJson } from './lib/repo.mjs';

export const BASELINE = 'scripts/dir-size.baseline.json';
export const DIR_LIMIT = 15;

/** Files that are inputs, snapshots or served assets, not modules a reader navigates. */
const NOT_LOOSE = /(^|\/)(__snapshots__|fixtures|static)\//;

/** `{ dir: count }` of loose non-test files per directory (`.` for the root), all directories. */
export function countDirs(paths) {
  const counts = {};
  for (const p of paths) {
    if (isTest(p) || NOT_LOOSE.test(p)) continue;
    const dir = posix.dirname(p);
    counts[dir] = (counts[dir] ?? 0) + 1;
  }
  return counts;
}

/**
 * What grew past its ceiling (or past the limit without one), what shrank below its ceiling so
 * the baseline can follow, and which exemptions or ceilings name a directory that is gone or
 * back under the limit.
 */
export function ratchet(counts, { ceilings, exempt }) {
  const grew = [];
  const shrank = [];
  const stale = [];
  for (const [dir, n] of Object.entries(counts)) {
    if (dir in exempt) continue;
    const ceiling = ceilings[dir] ?? DIR_LIMIT;
    if (n > ceiling) grew.push(`${dir}: ${n} (ceiling ${ceiling})`);
  }
  for (const [dir, ceiling] of Object.entries(ceilings)) {
    const n = counts[dir] ?? 0;
    if (n <= DIR_LIMIT) stale.push(`${dir}: ${n}, within ${DIR_LIMIT}; remove the ceiling`);
    else if (n < ceiling) shrank.push(`${dir}: ${n} (ceiling ${ceiling})`);
  }
  for (const dir of Object.keys(exempt))
    if (!(dir in counts)) stale.push(`${dir}: gone; remove the exemption`);
  return { grew, shrank, stale };
}

test('no directory grows past 15 loose non-test files or past its ceiling', () => {
  const paths = gitFiles() ?? [];
  assert.ok(paths.length > 500, 'found the tracked files');
  const baseline = readJson(BASELINE);
  const { grew, shrank, stale } = ratchet(countDirs(paths), baseline);
  assert.deepEqual(grew, [], 'group related files into a subdirectory instead');
  assert.deepEqual(shrank, [], `fewer files: lower these ceilings in ${BASELINE}`);
  assert.deepEqual(stale, [], `update ${BASELINE}`);
  for (const [dir, reason] of Object.entries(baseline.exempt))
    assert.ok(reason.length > 10, `${dir}: an exemption names its reason`);
});

test('tests, snapshots, fixtures and static assets do not count; each finding is named', () => {
  const many = (dir, n, ext = '.ts') => Array.from({ length: n }, (_, i) => `${dir}/m${i}${ext}`);
  const counts = countDirs([
    ...many('a', 17),
    ...many('a', 5, '.test.ts'),
    'a/__snapshots__/x.snap',
    'a/fixtures/p.json',
    'a/static/x.png',
    ...many('b', 12),
    ...many('c', 16),
    ...many('n', 30, '.sql'),
    'README.md',
  ]);
  assert.deepEqual(counts, { a: 17, b: 12, c: 16, n: 30, '.': 1 });
  assert.deepEqual(
    ratchet(counts, { ceilings: { a: 18, b: 20, d: 19 }, exempt: { n: 'numbered', gone: 'x' } }),
    {
      grew: ['c: 16 (ceiling 15)'],
      shrank: ['a: 17 (ceiling 18)'],
      stale: [
        'b: 12, within 15; remove the ceiling',
        'd: 0, within 15; remove the ceiling',
        'gone: gone; remove the exemption',
      ],
    }
  );
});
