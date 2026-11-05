// The docs stay readable as plain text and on GitHub: no table row over `ROW_LIMIT` characters, and
// the overview stays a map under `OVERVIEW_LIMIT` bytes, with the detail on the reference pages.
// A row of 1,500 characters reads as a wall in a diff, and Prettier pads every row of the table to
// it. A doc already past the limit is listed in docs-shape.baseline.json and can only go down.
// Run by `npm run lint:infra`, offline.
// Rejected: a limit on file size for every doc (a reference page may grow with its module; a table
// that has outgrown its cells is the shape that made these hard to read).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFiles, readAll, readJson } from '../lib/repo.mjs';

export const ROW_LIMIT = 400;
export const OVERVIEW_LIMIT = 12 * 1024;
const BASELINE = 'scripts/gates/docs-shape.baseline.json';

/** The length of the longest table row in `text`; 0 without a table. */
export const longestRow = (text) =>
  Math.max(0, ...text.split('\n').map((line) => (line.startsWith('|') ? line.length : 0)));

/** A doc over the limit or over its own baseline, and a baseline that can follow a shrunk doc. */
export function rowFindings(files, baseline, limit = ROW_LIMIT) {
  const findings = [];
  for (const { path, text } of files) {
    const longest = longestRow(text);
    const allowed = baseline[path] ?? limit;
    if (longest > allowed) findings.push(`${path}: a table row of ${longest}, limit ${allowed}`);
    if (path in baseline && longest < allowed)
      findings.push(`${path}: longest row now ${longest}, lower its baseline from ${allowed}`);
  }
  return findings;
}

const docs = () => readAll((gitFiles() ?? []).filter((p) => /^(docs\/.*|[^/]+)\.md$/.test(p)));

test('no table row in the docs is over the limit, and the baseline only goes down', () => {
  const files = docs();
  assert.ok(files.length > 30, 'found the docs');
  assert.deepEqual(rowFindings(files, readJson(BASELINE)), []);
});

test('testing.md holds to the limit itself', () => {
  assert.ok(!('docs/architecture/testing.md' in readJson(BASELINE)));
});

test('the overview stays a map', () => {
  const [{ text }] = readAll(['docs/architecture/overview.md']);
  const bytes = Buffer.byteLength(text);
  assert.ok(bytes <= OVERVIEW_LIMIT, `overview.md is ${bytes} bytes, limit ${OVERVIEW_LIMIT}`);
});

test('a long row, a shrunk baseline and a row over its baseline are findings', () => {
  const row = (n) => `|${'x'.repeat(n - 1)}`;
  assert.equal(longestRow(`intro ${'y'.repeat(900)}\n${row(20)}\n`), 20);
  assert.deepEqual(rowFindings([{ path: 'a.md', text: row(11) }], {}, 10), [
    'a.md: a table row of 11, limit 10',
  ]);
  assert.deepEqual(rowFindings([{ path: 'a.md', text: row(30) }], { 'a.md': 20 }), [
    'a.md: a table row of 30, limit 20',
  ]);
  assert.deepEqual(rowFindings([{ path: 'a.md', text: row(10) }], { 'a.md': 20 }), [
    'a.md: longest row now 10, lower its baseline from 20',
  ]);
});
