// `tarEntries` lists an archive whose listing is larger than `execFile`'s 1 MiB stdout buffer, and
// a tar that fails stays a failure with its exit status. Run by `npm run lint:infra`,
// offline, with the system tar as the export e2e uses it.
// Rejected: a checked-in large archive (a binary in the repo for one test) and a mocked spawn
// (it would not prove the buffer limit is gone).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tarEntries } from './tar-entries.mjs';

test('an archive listing past 1 MiB comes back whole, in order', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tar-entries-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'tables'));
  const count = 12_000;
  const names = Array.from({ length: count }, (_, i) => `${'x'.repeat(80)}-${i}.ndjson`);
  writeFileSync(join(dir, 'manifest.json'), '{}');
  for (const name of names) writeFileSync(join(dir, 'tables', name), '');
  const archive = join(dir, 'probe.tar');
  // The manifest first, as the export writes it; then the directory with every table.
  execFileSync('tar', ['-cf', archive, '-C', dir, 'manifest.json', 'tables']);

  const entries = await tarEntries(archive);
  assert.ok(entries.join('\n').length > 1024 * 1024, 'the listing exceeds the old buffer');
  assert.equal(entries[0], 'manifest.json');
  const tables = entries.filter((e) => e.startsWith('tables/') && e !== 'tables/');
  assert.equal(tables.length, count);
  assert.ok(entries.includes(`tables/${names[count - 1]}`));
});

test('a file that is no archive rejects with the exit status and tar stderr', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tar-entries-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'broken.tar');
  writeFileSync(file, 'not a tar archive, but long enough to be read as one '.repeat(20));
  await assert.rejects(tarEntries(file), /exited with [1-9]\d*: \S/);
});

test('a missing file rejects instead of listing nothing', async () => {
  await assert.rejects(tarEntries(join(tmpdir(), 'tar-entries-missing.tar')), /exited with/);
});
