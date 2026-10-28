// The end-to-end budget of docs/architecture/testing.md: at most one spec per flow where money,
// consent or access changes hands, target ten. The suite had grown to nineteen specs with eleven
// copies of the login, ten of the axe check and fifteen of the layout gate, in five variants, so a
// check added to one copy never reached the others (TODO #50). Each shared check now lives once in
// apps/web/e2e/lib/ and this test keeps it there; the suite holds ten specs, each naming its flow.
// Run by `npm run lint:infra`, offline.
// Rejected: a lint rule per pattern (the e2e folder is outside the typechecked and linted
// workspace sources) and a review checklist (the copies arrived through reviewed PRs).

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const dir = fileURLToPath(new URL('../apps/web/e2e/', import.meta.url));

/** testing.md's budget. A new flow replaces a spec or makes the case to raise this in review. */
export const MAX_SPECS = 10;

/** The first line of a spec names its flow; the generic gate names none. */
export const FLOW = /^\/\/ flow: (money|consent|access|publish|none, the generic gate)\b/;

/** What only apps/web/e2e/lib/ may hold, with the specs that still may and why. */
export const RULES = [
  { name: 'a login helper', pattern: /function login\b|name: 'Mock IdP' }\)\)\.toBeVisible/ },
  { name: 'an axe helper', pattern: /function expectNoAxeViolations\b|new AxeBuilder\(/ },
  {
    name: 'a layout gate',
    pattern: /function layoutProblems\b|scrollWidth > (document\.)?\w+\.clientWidth/,
  },
  { name: 'a text-size setter', pattern: /documentElement\.style\.fontSize = / },
  { name: 'a unit of work', pattern: /new Invoker\(|createUnitOfWork\(/ },
  { name: 'console output', pattern: /console\.log\(/ },
];

/**
 * Deliberate exceptions, `<spec>: <rule name>` with the reason. The logout and the second-login
 * test meet the IdP on purpose; the quality corpus keeps axe's `incomplete` results as evidence;
 * on the public site, site settings resets the text size before it measures CSS zoom on its own
 * and the grid compositions record overflow with the rails they attach as evidence.
 */
export const ALLOWED = new Set([
  'admin.spec.ts: a login helper',
  'quality-corpus.spec.ts: an axe helper',
  'public-site.spec.ts: a text-size setter',
  'public-site.spec.ts: a layout gate',
]);

/** Violations in `files`, a map of spec name to source. */
export function violations(files) {
  const out = [];
  for (const [name, source] of Object.entries(files))
    for (const rule of RULES)
      if (rule.pattern.test(source) && !ALLOWED.has(`${name}: ${rule.name}`))
        out.push(`${name} defines ${rule.name}; use apps/web/e2e/lib/`);
  return out;
}

const specs = () =>
  Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.spec.ts'))
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')])
  );

test('the spec count stays within its budget', () => {
  const count = Object.keys(specs()).length;
  assert.ok(count <= MAX_SPECS, `${count} specs, budget ${MAX_SPECS} (testing.md)`);
});

test('every spec names its flow on its first line', () => {
  const untagged = Object.entries(specs())
    .filter(([, source]) => !FLOW.test(source))
    .map(([name]) => name);
  assert.deepEqual(untagged, []);
});

test('every shared check lives once, in apps/web/e2e/lib/', () => {
  assert.deepEqual(violations(specs()), []);
});

test('every exception is still needed', () => {
  const files = specs();
  const stale = [...ALLOWED].filter((entry) => {
    const [name, rule] = entry.split(': ');
    const pattern = RULES.find((r) => r.name === rule)?.pattern;
    return !pattern || !files[name] || !pattern.test(files[name]);
  });
  assert.deepEqual(stale, []);
});

test('a copied helper is caught', () => {
  assert.deepEqual(violations({ 'x.spec.ts': 'async function login(page) {}\nconsole.log(1);' }), [
    'x.spec.ts defines a login helper; use apps/web/e2e/lib/',
    'x.spec.ts defines console output; use apps/web/e2e/lib/',
  ]);
});
