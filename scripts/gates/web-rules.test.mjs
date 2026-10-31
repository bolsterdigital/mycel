// The web front rebuilds rules that core or a web helper already owns, and every copy drifts on
// its own (TODO #51): a route that catches `UseCaseError` itself maps `forbidden` to 400, a link
// regex lets through what `isSafeHref` refuses. Until the sweep removes them, each kind of copy
// only goes down, per file, against scripts/gates/web-rules.baseline.json; a rule at zero stays
// at zero. Run by `npm run lint:infra`, offline.
// Rejected: one-home.test.mjs (it allows no copy at all, and these have dozens until the sweep),
// and one total per rule (a removed copy and a new one elsewhere cancel out silently).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, readAll, readJson, stripComments, walk } from '../lib/repo.mjs';

export const BASELINE = 'scripts/gates/web-rules.baseline.json';
const WEB = 'apps/web/src/';
const ROUTES = `${WEB}routes/`;

/** `{ key: [what, pattern, scope] }`: a copy of `what` is `pattern` in a source under `scope`. */
export const RULES = {
  'use-case-catch': [
    'a UseCaseError caught by hand in a route (use act or failureOf from lib/server/admin)',
    /instanceof\s+UseCaseError\b/g,
    ROUTES,
  ],
  'error-copy': [
    'an error message written in a route (throw a catalogue key)',
    /\berror\(\s*\d{3}\s*,\s*['"`]/g,
    ROUTES,
  ],
  'link-regex': [
    'a link scheme matched by hand (use isSafeHref from @mycel/core)',
    /https\?:/g,
    WEB,
  ],
  'locale-fallback': [
    'a localised value picked by hand (use pick from @mycel/core)',
    /Object\.values\([^()]*\)\s*(?:\[0\]|\.find\()/g,
    WEB,
  ],
  'english-default': [
    'a fallback to English written by hand (one lang() helper)',
    /\?\?\s*['"]en['"]/g,
    WEB,
  ],
  'uuid-regex': [
    'a UUID pattern written by hand (one matcher in src/params/)',
    /\[0-9a-f\]\{8\}/gi,
    WEB,
  ],
};

/** `{ key: { path: count } }` of every copy in `files`, tests and comments left out. */
export function countCopies(files, rules = RULES) {
  const counts = Object.fromEntries(Object.keys(rules).map((key) => [key, {}]));
  for (const { path, text } of files) {
    if (isTest(path)) continue;
    const code = stripComments(text);
    for (const [key, [, pattern, scope]] of Object.entries(rules)) {
      if (!path.startsWith(scope)) continue;
      const n = (code.match(pattern) ?? []).length;
      if (n) counts[key][path] = n;
    }
  }
  return counts;
}

/** What grew past the baseline, and what shrank below it so the baseline can follow. */
export function ratchet(counts, baseline, rules = RULES) {
  const grew = [];
  const shrank = [];
  for (const [key, [what]] of Object.entries(rules)) {
    const now = counts[key] ?? {};
    const then = baseline[key] ?? {};
    for (const [p, n] of Object.entries(now))
      if (n > (then[p] ?? 0)) grew.push(`${p}: ${n}× ${what} (baseline ${then[p] ?? 0})`);
    for (const [p, n] of Object.entries(then))
      if ((now[p] ?? 0) < n) shrank.push(`${key} ${p}: ${now[p] ?? 0} (baseline ${n})`);
  }
  for (const key of Object.keys(baseline))
    if (!(key in rules)) shrank.push(`${key}: no such rule; remove it`);
  return { grew, shrank };
}

const sources = () => readAll(walk(WEB, { match: (p) => /\.(?:[cm]?[jt]s|svelte)$/.test(p) }));

test('copies of core and helper rules in the web front only go down', () => {
  const files = sources();
  assert.ok(files.length > 100, 'found the web sources');
  const { grew, shrank } = ratchet(countCopies(files), readJson(BASELINE));
  assert.deepEqual(grew, [], 'use the helper the rule names instead');
  assert.deepEqual(shrank, [], `fewer copies: lower these entries in ${BASELINE}`);
});

test('each rule sees its copy, within its scope, and not in comments or tests', () => {
  const lib = `${WEB}lib/x.ts`;
  const route = `${ROUTES}a/+page.server.ts`;
  const view = `${ROUTES}a/+page.svelte`;
  assert.deepEqual(
    countCopies([
      {
        path: route,
        text: [
          'if (e instanceof UseCaseError) return fail(400);',
          "throw error(404, 'Not found');",
          'throw error(403, `${cap}`);',
          'const lang = locals.lang ?? "en";',
          'const ID = /^[0-9a-f]{8}-[0-9a-f]{4}$/;',
        ].join('\n'),
      },
      { path: view, text: '<script>if (/^(https?:\\/\\/|mailto:)/.test(h)) ok();</script>' },
      {
        path: lib,
        text: [
          'const t = title[locale] ?? Object.values(title)[0];',
          "const s = map[l] || Object.values(map).find((x) => x) || '';",
          'e instanceof UseCaseError;',
          "error(500, 'x');",
          'Object.values(value).every((v) => v === "");',
        ].join('\n'),
      },
      { path: `${ROUTES}b/+page.server.ts`, text: "// e instanceof UseCaseError ?? 'en'" },
      { path: `${ROUTES}b/x.test.ts`, text: 'e instanceof UseCaseError' },
      { path: 'packages/core/src/x.ts', text: "e instanceof UseCaseError; x ?? 'en'" },
    ]),
    {
      'use-case-catch': { [route]: 1 },
      'error-copy': { [route]: 2 },
      'link-regex': { [view]: 1 },
      'locale-fallback': { [lib]: 2 },
      'english-default': { [route]: 1 },
      'uuid-regex': { [route]: 1 },
    }
  );
});

test('a new copy and a removed one are both reported, and a dropped rule too', () => {
  const [what] = RULES['uuid-regex'];
  assert.deepEqual(
    ratchet(
      { 'uuid-regex': { 'a.ts': 2, 'b.ts': 1 } },
      { 'uuid-regex': { 'a.ts': 1, 'c.ts': 1 }, 'gone-rule': {} }
    ),
    {
      grew: [`a.ts: 2× ${what} (baseline 1)`, `b.ts: 1× ${what} (baseline 0)`],
      shrank: ['uuid-regex c.ts: 0 (baseline 1)', 'gone-rule: no such rule; remove it'],
    }
  );
});
