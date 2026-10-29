// Small helpers that were copied by hand until the copies drifted live in one file each (TODO
// #74). This ratchet fails `npm run lint:infra` when a fragment listed below appears in a source
// file of the packages and apps other than its home; a new helper with copies joins the list
// with the sweep that removes them. Run offline.
// Rejected: one ratchet file per helper (http-edges.test.mjs stays separate because it guards a
// set of edges, not one fragment), and a count per file (a helper is shared or it is not).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, stripComments, workspaceSources } from './lib/repo.mjs';

/** `[what, home, pattern]`: what only `home` may write. */
export const HOMES = [
  [
    'the text of a thrown value (use errorMessage or errorFields)',
    'packages/core/src/util/log.ts',
    /instanceof\s+Error\s*\?\s*[\w.]+\.message\s*:\s*String\(/,
  ],
];

/** `path: what` for every fragment outside its home. */
export function strays(files, homes = HOMES) {
  return files
    .filter(({ path }) => !isTest(path))
    .flatMap(({ path, text }) => {
      const code = stripComments(text);
      return homes
        .filter(([, home, pattern]) => path !== home && pattern.test(code))
        .map(([what]) => `${path}: ${what}`);
    });
}

test('each listed helper is written only in its home', () => {
  const files = workspaceSources();
  for (const [what, home, pattern] of HOMES)
    assert.ok(
      files.some((f) => f.path === home && pattern.test(f.text)),
      `the scan finds ${what} in ${home}`
    );
  assert.deepEqual(strays(files), []);
});

test('the rule names a copy, and ignores comments, tests and the home file', () => {
  const [[what, home]] = HOMES;
  assert.deepEqual(
    strays([
      {
        path: 'packages/db/src/x.ts',
        text: 'const m = e instanceof Error ? e.message : String(e);',
      },
      {
        path: 'packages/api/src/y.ts',
        text: '{ error: err instanceof Error\n ? err.message : String(err) }',
      },
      { path: 'packages/db/src/ok.ts', text: '// e instanceof Error ? e.message : String(e)' },
      { path: 'packages/db/src/a.test.ts', text: 'e instanceof Error ? e.message : String(e)' },
      { path: home, text: 'e instanceof Error ? e.message : String(e)' },
    ]),
    [`packages/db/src/x.ts: ${what}`, `packages/api/src/y.ts: ${what}`]
  );
});
