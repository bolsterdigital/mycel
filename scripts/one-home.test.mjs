// Small helpers that were copied by hand until the copies drifted live in one file each (TODO
// #74). This ratchet fails `npm run lint:infra` when a fragment listed below appears in a source
// file of the packages and apps other than its home; a new helper with copies joins the list
// with the sweep that removes them. Run offline.
// Rejected: one ratchet file per helper (http-edges.test.mjs stays separate because it guards a
// set of edges, not one fragment), and a count per file (a helper is shared or it is not).
// A home is a file, a directory (ending in `/`) or a pattern over paths (every module's
// `ports.ts`); an optional scope limits where a fragment counts as a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, stripComments, workspaceSources } from './lib/repo.mjs';

/** `[what, home, pattern, scope?]`: what only `home` may write, within `scope` (a path prefix). */
export const HOMES = [
  [
    'the text of a thrown value (use errorMessage or errorFields)',
    'packages/core/src/util/log.ts',
    /instanceof\s+Error\s*\?\s*[\w.]+\.message\s*:\s*String\(/,
  ],
  // TODO #72: one wording for a missing record, and suspension read only through the guards, so a
  // rule written by hand cannot drift from the one `Invoker.run` and the job handlers apply.
  [
    "a 'not_found' error (use notFound)",
    'packages/core/src/errors.ts',
    /UseCaseError\(\s*'not_found'/,
  ],
  [
    'a tenant status compared by hand (use active or requireActive)',
    'packages/core/src/entitlements/guards.ts',
    /tenantStatus\s*[!=]==/,
  ],
  // TODO #72 step 9: a limit or a feature read straight from the document skips the refusal key
  // every front maps; the web may read one to show or hide a control, core never decides by it.
  [
    'an entitlement read outside the entitlements module (use entitled, requireEntitled or withinLimit)',
    'packages/core/src/entitlements/',
    /\.entitlements\s*[[;]|\{[^}]*\bentitlements\b[^}]*\}\s*=\s*[\w.]+\s*;/,
    'packages/core/',
  ],
  [
    'a port declared outside a ports.ts (ADR 001: the contract an adapter implements)',
    /^packages\/core\/src\/[\w-]+\/ports\.ts$/,
    /declare\s+module\s+['"]/,
  ],
  [
    'a nullable date as ISO by hand (use iso)',
    'packages/core/src/util/date.ts',
    /toISOString\(\)\s*\?\?\s*null/,
  ],
  [
    'a made-up example id by hand (use exampleId)',
    'packages/core/src/util/ids.ts',
    /01900000-0000-7000-8000-/,
  ],
];

const isHome = (path, home) =>
  typeof home === 'string'
    ? path === home || (home.endsWith('/') && path.startsWith(home))
    : home.test(path);

/** `path: what` for every fragment outside its home. */
export function strays(files, homes = HOMES) {
  return files
    .filter(({ path }) => !isTest(path))
    .flatMap(({ path, text }) => {
      const code = stripComments(text);
      return homes
        .filter(
          ([, home, pattern, scope = '']) =>
            path.startsWith(scope) && !isHome(path, home) && pattern.test(code)
        )
        .map(([what]) => `${path}: ${what}`);
    });
}

test('each listed helper is written only in its home', () => {
  const files = workspaceSources();
  for (const [what, home, pattern] of HOMES)
    assert.ok(
      files.some((f) => isHome(f.path, home) && pattern.test(f.text)),
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

test('a directory home, a pattern home and a scope', () => {
  const entitlement = HOMES.find(([what]) => what.startsWith('an entitlement'));
  const port = HOMES.find(([what]) => what.startsWith('a port'));
  assert.deepEqual(
    strays(
      [
        {
          path: 'packages/core/src/assist/service.ts',
          text: 'const e = ctx.principal.entitlements;',
        },
        { path: 'packages/core/src/entitlements/service.ts', text: 'const e = p.entitlements;' },
        {
          path: 'packages/core/src/forms/guard.ts',
          text: 'const { entitlements } = ctx.principal;',
        },
        { path: 'apps/web/src/lib/x.ts', text: "if (principal.entitlements['ai.assist']) show();" },
        { path: 'packages/core/src/forms/service.ts', text: "declare module '../ports.js' {}" },
        { path: 'packages/core/src/forms/ports.ts', text: "declare module '../ports.js' {}" },
      ],
      [entitlement, port]
    ),
    [
      `packages/core/src/assist/service.ts: ${entitlement[0]}`,
      `packages/core/src/forms/guard.ts: ${entitlement[0]}`,
      `packages/core/src/forms/service.ts: ${port[0]}`,
    ]
  );
});
