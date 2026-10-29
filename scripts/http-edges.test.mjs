// The HTTP edges of packages/api live once, in `http-shape.ts` (TODO #74 step 3): the ETag and its
// If-None-Match rule, the JSON body read, the 401 with `www-authenticate` and the error handler.
// Each Hono app had its own copy, and the copies drifted (the platform's handler counted no
// refusals). This ratchet fails `npm run lint:infra` when one of those fragments appears in another
// source file of packages/api, or an `onError` takes anything but `problemOnError`. The
// If-None-Match rule has a home of its own, `conditional.ts`, because the public site shares it
// (`@mycel/api/conditional`); apps/web is scanned for that rule too. Run offline.
// Rejected: a count per file (an edge is shared or it is not; there is no allowance to shrink).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, readAll, stripComments, walk } from './lib/repo.mjs';

export const HOME = 'packages/api/src/http-shape.ts';
export const RULE_HOME = 'packages/api/src/conditional.ts';
const API = 'packages/api/src/';
const WEB = 'apps/web/src/';

/** `[what, pattern, home, scanned]`: what only `home` may write, in files under `scanned`. */
export const EDGES = [
  ['a weak ETag', /W\/"/, HOME, [API]],
  // Stops at `^W\`: `stripComments` reads the `//` of `/^W\//` as a comment.
  ['the If-None-Match rule', /\^W\\/, RULE_HOME, [API, WEB]],
  ['a 304', /status:\s*304/, HOME, [API]],
  ['the JSON body refusal', /body must be JSON/, HOME, [API]],
  ['a www-authenticate header', /www-authenticate/i, HOME, [API]],
  ['an error handler other than problemOnError', /\.onError\(\s*(?!problemOnError\b)/, HOME, [API]],
];

/** `path: what` for every fragment outside its home. */
export function strayEdges(files) {
  return files
    .filter(({ path }) => !isTest(path))
    .flatMap(({ path, text }) => {
      const code = stripComments(text);
      return EDGES.filter(
        ([, pattern, home, scanned]) =>
          path !== home && scanned.some((dir) => path.startsWith(dir)) && pattern.test(code)
      ).map(([what]) => `${path}: ${what}`);
    });
}

const sources = () =>
  readAll(
    [API, WEB].flatMap((dir) => walk(dir.slice(0, -1), { match: (p) => /\.[cm]?ts$/.test(p) }))
  );

test('packages/api writes its HTTP edges only in http-shape.ts', () => {
  const files = sources();
  for (const home of [HOME, RULE_HOME, 'apps/web/src/lib/server/http-cache.ts'])
    assert.ok(
      files.some((f) => f.path === home),
      `the scan finds ${home}`
    );
  assert.deepEqual(strayEdges(files), []);
});

test('the rule names a copied edge, and ignores comments, tests and the home file', () => {
  assert.deepEqual(
    strayEdges([
      { path: 'packages/api/src/x.ts', text: "headers: { 'WWW-Authenticate': 'Bearer' }" },
      { path: 'packages/api/src/y.ts', text: "app.onError((e) => problem('internal'));" },
      {
        path: 'packages/api/src/z.ts',
        text: "tag.replace(/^W\\//, '');\nnew Response(null, { status: 304 })",
      },
      { path: 'apps/web/src/lib/server/c.ts', text: "tag.replace(/^W\\//, '');" },
      { path: 'apps/web/src/lib/server/ok.ts', text: 'new Response(null, { status: 304 })' },
      { path: RULE_HOME, text: "tag.replace(/^W\\//, '');" },
      {
        path: 'packages/api/src/ok.ts',
        text: 'app.onError(problemOnError(obs));\n// body must be JSON',
      },
      { path: 'packages/api/src/a.test.ts', text: "'body must be JSON'" },
      { path: HOME, text: "'body must be JSON'" },
    ]),
    [
      'packages/api/src/x.ts: a www-authenticate header',
      'packages/api/src/y.ts: an error handler other than problemOnError',
      'packages/api/src/z.ts: the If-None-Match rule',
      'packages/api/src/z.ts: a 304',
      'apps/web/src/lib/server/c.ts: the If-None-Match rule',
    ]
  );
});
