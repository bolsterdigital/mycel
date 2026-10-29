// The HTTP edges of packages/api live once, in `http-shape.ts` (TODO #74 step 3): the ETag and its
// If-None-Match rule, the JSON body read, the 401 with `www-authenticate` and the error handler.
// Each Hono app had its own copy, and the copies drifted (the platform's handler counted no
// refusals). This ratchet fails `npm run lint:infra` when one of those fragments appears in another
// source file of packages/api, or an `onError` takes anything but `problemOnError`. Run offline.
// Rejected: a count per file (an edge is shared or it is not; there is no allowance to shrink).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, readAll, stripComments, walk } from './lib/repo.mjs';

export const HOME = 'packages/api/src/http-shape.ts';

/** What only `http-shape.ts` may write, by what it is. */
export const EDGES = [
  // Stops at `^W\`: `stripComments` reads the `//` of `/^W\//` as a comment.
  ['a weak ETag or the If-None-Match rule', /W\/"|\^W\\/],
  ['a 304', /status:\s*304/],
  ['the JSON body refusal', /body must be JSON/],
  ['a www-authenticate header', /www-authenticate/i],
  ['an error handler other than problemOnError', /\.onError\(\s*(?!problemOnError\b)/],
];

/** `path: what` for every fragment outside `HOME`. */
export function strayEdges(files) {
  return files
    .filter(({ path }) => !isTest(path) && path !== HOME)
    .flatMap(({ path, text }) => {
      const code = stripComments(text);
      return EDGES.filter(([, pattern]) => pattern.test(code)).map(([what]) => `${path}: ${what}`);
    });
}

const sources = () => readAll(walk('packages/api/src', { match: (p) => /\.[cm]?ts$/.test(p) }));

test('packages/api writes its HTTP edges only in http-shape.ts', () => {
  const files = sources();
  assert.ok(
    files.some((f) => f.path === HOME),
    'the scan finds http-shape.ts'
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
      'packages/api/src/z.ts: a weak ETag or the If-None-Match rule',
      'packages/api/src/z.ts: a 304',
    ]
  );
});
