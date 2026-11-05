// No tracked code file holds more than 1,000 lines, and the files that already do only shrink:
// each against its ceiling in scripts/gates/file-size.baseline.json. `repo-size` stops a PNG at
// 200 KB, roughly 4,300 lines of code, and `dir-size` counts files, so a stylesheet or a route
// could triple without any gate noticing. Copy catalogues and other data are exempt in the same
// baseline, each with its reason. A ceiling goes up only by making the case in review, as with
// `MAX_SPECS`. Run by `npm run lint:infra`, offline.
// Rejected: a limit in bytes (a long line of CSS and a long line of TypeScript do not cost a reader
// the same, and the failure should say what a reader sees) and an average per package (a split in
// one place hides growth in another).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitFiles, ratchet, readAll, readJson } from '../lib/repo.mjs';

export const BASELINE = 'scripts/gates/file-size.baseline.json';
export const FILE_LIMIT = 1000;

/** What a reader navigates as code or as data next to it; binaries and prose have other gates. */
const CODE = /\.(?:[cm]?[jt]s|svelte|css|sql|sh|ya?ml|json)$/;

/**
 * Not counted. End-to-end specs: `SPEC_LIMIT` in `e2e-budget` bounds them. Migrations: numbered and
 * forward-only, so one cannot be split once applied. Fixtures: inputs, not modules.
 */
const NOT_COUNTED = /^apps\/web\/e2e\/.*\.spec\.ts$|^packages\/db\/migrations\/|(^|\/)fixtures\//;

/** The lines of `text`; a final newline does not start another one. */
export const countLines = (text) =>
  text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** The paths this gate reads. */
export const counted = (paths) => paths.filter((p) => CODE.test(p) && !NOT_COUNTED.test(p));

/** `{ path: lines }` for `[{ path, text }]`. */
export const countFiles = (files) =>
  Object.fromEntries(files.map(({ path, text }) => [path, countLines(text)]));

test('no code file grows past 1,000 lines or past its ceiling', () => {
  const paths = counted(gitFiles() ?? []);
  assert.ok(paths.length > 500, 'found the tracked code');
  const baseline = readJson(BASELINE);
  const { grew, shrank, stale } = ratchet(countFiles(readAll(paths)), baseline, FILE_LIMIT);
  assert.deepEqual(grew, [], 'move a subject into a file of its own instead');
  assert.deepEqual(shrank, [], `fewer lines: lower these ceilings in ${BASELINE}`);
  assert.deepEqual(stale, [], `update ${BASELINE}`);
  for (const [path, reason] of Object.entries(baseline.exempt))
    assert.ok(reason.length > 10, `${path}: an exemption names its reason`);
});

test('specs, migrations, fixtures and binaries do not count; tests and stylesheets do', () => {
  assert.deepEqual(
    counted([
      'apps/web/e2e/admin.spec.ts',
      'apps/web/e2e/lib/editor.ts',
      'apps/web/e2e/fonts/DejaVuSans.ttf',
      'apps/web/src/lib/admin/ui/ui.css',
      'apps/web/src/lib/admin/ui/ui.test.ts',
      'apps/web/src/routes/a/+page.svelte',
      'packages/db/migrations/0001_init.sql',
      'packages/db/fixtures/dump.sql',
      'scripts/gates/fixtures/history.json',
      'docs/adr/001.md',
    ]),
    [
      'apps/web/e2e/lib/editor.ts',
      'apps/web/src/lib/admin/ui/ui.css',
      'apps/web/src/lib/admin/ui/ui.test.ts',
      'apps/web/src/routes/a/+page.svelte',
    ]
  );
});

test('a line count matches what an editor shows, with or without a final newline', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\n\n'), 2);
});

test('a file past its ceiling is red, a smaller one and a needless allowance are reported', () => {
  const lines = (n) => 'x\n'.repeat(n);
  const counts = countFiles(
    [
      ['grew-past-limit.ts', 1001],
      ['at-limit.ts', 1000],
      ['grew-past-ceiling.css', 1201],
      ['at-ceiling.css', 1200],
      ['shrank.ts', 1100],
      ['back-under.ts', 900],
      ['catalogue.ts', 5000],
      ['small-catalogue.ts', 10],
    ].map(([path, n]) => ({ path, text: lines(n) }))
  );
  const baseline = {
    ceilings: {
      'grew-past-ceiling.css': 1200,
      'at-ceiling.css': 1200,
      'shrank.ts': 1200,
      'back-under.ts': 1200,
      'deleted.ts': 1200,
    },
    exempt: {
      'catalogue.ts': 'copy, one entry per string',
      'small-catalogue.ts': 'copy, one entry per string',
      'deleted-catalogue.ts': 'copy, one entry per string',
    },
  };
  assert.deepEqual(ratchet(counts, baseline, FILE_LIMIT), {
    grew: ['grew-past-limit.ts: 1001 (ceiling 1000)', 'grew-past-ceiling.css: 1201 (ceiling 1200)'],
    shrank: ['shrank.ts: 1100 (ceiling 1200)'],
    stale: [
      'back-under.ts: 900, within 1000; remove the ceiling',
      'deleted.ts: 0, within 1000; remove the ceiling',
      'small-catalogue.ts: 10, within 1000; remove the exemption',
      'deleted-catalogue.ts: gone; remove the exemption',
    ],
  });
});
