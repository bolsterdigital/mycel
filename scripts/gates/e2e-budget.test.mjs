// The end-to-end budget of docs/architecture/testing.md: at most one spec per flow where money,
// consent or access changes hands, target ten. The suite had grown to nineteen specs with eleven
// copies of the login, ten of the axe check and fifteen of the layout gate, in five variants, so a
// check added to one copy never reached the others (TODO #50). Each shared check now lives once in
// apps/web/e2e/lib/ and this test keeps it there; the suite holds ten specs, each naming its flow.
// Since TODO #75 that includes which project a test runs in, the API's address and key, and the
// wait for a form's minimum fill time. Since TODO #171 it also bounds each spec and each test: the
// spec count alone did not stop growth, since lines doubled at the same ten specs, and a spec in a
// subfolder escaped the count altogether.
// Run by `npm run lint:infra`, offline.
// Rejected: a lint rule per pattern (the e2e folder is outside the typechecked and linted
// workspace sources) and a review checklist (the copies arrived through reviewed PRs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAll, staleEntries, walk } from '../lib/repo.mjs';

const dir = 'apps/web/e2e';

/** testing.md's budget. A new flow replaces a spec or makes the case to raise this in review. */
export const MAX_SPECS = 10;

/** A spec past this is two flows, or a flow whose copy checks belong in unit tests. */
export const SPEC_LIMIT = 100 * 1024;

/** A test past this hides several claims behind one title. */
export const TEST_LINES = 150;

/**
 * Tests still past TEST_LINES, `<spec>: <start of the title>` with their exact length, so it can
 * only shrink: a shorter test has to lower its number here, and one under the limit leaves.
 */
export const LONG_TESTS = new Map([['article-writing.spec.ts: TipTap saves headings', 162]]);

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
  { name: 'a project check', pattern: /project\.name [!=]==? ['"](a11y|no-js)['"]/ },
  { name: 'an API address or key', pattern: /process\.env\[['"](E2E_API_URL|MYCEL_API_KEY)['"]\]/ },
  { name: 'a fixed wait', pattern: /waitForTimeout\(/ },
  { name: 'a new-page helper', pattern: /function newPage\b/ },
  { name: 'a silent project return', pattern: /if \(!isA11y\(\)\) return/ },
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

/** Every spec under the e2e folder, nested ones too; Playwright runs those as well. */
export const isSpec = (path) => path.startsWith(`${dir}/`) && path.endsWith('.spec.ts');

const specs = () =>
  Object.fromEntries(
    readAll(walk(dir, { match: isSpec })).map(({ path, text }) => [
      path.slice(dir.length + 1),
      text,
    ])
  );

/** `<spec>: <title>` and length of every test in `source`; closes on the indentation it opened at. */
export function testLengths(name, source) {
  const lines = source.split('\n');
  const out = [];
  lines.forEach((line, at) => {
    const open = /^(\s*)\w*[tT]est(?:\.only|\.skip|\.fixme)?\(/.exec(line);
    if (!open) return;
    const end = lines.findIndex(
      (l, i) => i > at && (l === `${open[1]}});` || l === `${open[1]});`)
    );
    if (end < 0) return;
    const title = /(['"`])(.+?)\1/.exec(line.slice(open[0].length) || lines[at + 1])?.[2] ?? '';
    out.push({ test: `${name}: ${title}`, lines: end - at + 1 });
  });
  return out;
}

/** What breaks the size limits in `files`, a map of spec name to source. */
export function sizeProblems(files, long = LONG_TESTS) {
  const out = [];
  const seen = new Set();
  for (const [name, source] of Object.entries(files)) {
    const bytes = Buffer.byteLength(source);
    if (bytes > SPEC_LIMIT) out.push(`${name} is ${bytes} bytes, limit ${SPEC_LIMIT}`);
    for (const { test: title, lines } of testLengths(name, source)) {
      const entry = [...long.keys()].find((key) => title.startsWith(key));
      if (entry) seen.add(entry);
      const ceiling = entry ? long.get(entry) : TEST_LINES;
      if (lines > ceiling) out.push(`${title} has ${lines} lines, limit ${ceiling}`);
      if (entry && lines < ceiling) out.push(`${entry} shrank to ${lines}: lower LONG_TESTS`);
    }
  }
  for (const entry of long.keys())
    if (!seen.has(entry)) out.push(`${entry} no longer exists: remove it from LONG_TESTS`);
  return out;
}

test('the spec count stays within its budget', () => {
  const count = Object.keys(specs()).length;
  assert.ok(count <= MAX_SPECS, `${count} specs, budget ${MAX_SPECS} (testing.md)`);
});

test('every spec and every test stays within its size', () => {
  assert.deepEqual(sizeProblems(specs()), []);
});

test('a nested spec counts, and a spec or test over its limit is caught', () => {
  assert.ok(isSpec('apps/web/e2e/sub/x.spec.ts'));
  assert.ok(!isSpec('apps/web/e2e/lib/x.ts'));
  const body = Array(TEST_LINES).fill('  a();').join('\n');
  assert.deepEqual(
    sizeProblems(
      {
        'big.spec.ts': 'x'.repeat(SPEC_LIMIT + 1),
        'long.spec.ts': `test('long', async () => {\n${body}\n});`,
        'ok.spec.ts': "test.describe('d', () => {\n  test('fine', () => {\n  });\n});",
      },
      new Map()
    ),
    [
      `big.spec.ts is ${SPEC_LIMIT + 1} bytes, limit ${SPEC_LIMIT}`,
      `long.spec.ts: long has ${TEST_LINES + 2} lines, limit ${TEST_LINES}`,
    ]
  );
});

test('a listed long test can only shrink, and leaves when it is gone', () => {
  const source = (n) => `test('long', () => {\n${Array(n).fill('  a();').join('\n')}\n});`;
  const long = new Map([['x.spec.ts: long', 200]]);
  assert.deepEqual(sizeProblems({ 'x.spec.ts': source(198) }, long), []);
  assert.match(sizeProblems({ 'x.spec.ts': source(199) }, long)[0], /has 201 lines, limit 200/);
  assert.match(sizeProblems({ 'x.spec.ts': source(197) }, long)[0], /shrank to 199/);
  assert.match(sizeProblems({}, long)[0], /no longer exists/);
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
  const needed = (entry) => {
    const [name, rule] = entry.split(': ');
    const pattern = RULES.find((r) => r.name === rule)?.pattern;
    return !!pattern && !!files[name] && pattern.test(files[name]);
  };
  assert.deepEqual(staleEntries(ALLOWED, needed, 'e2e-budget ALLOWED'), []);
});

test('a copied new-page helper is caught', () => {
  assert.deepEqual(violations({ 'x.spec.ts': 'async function newPage(page) {}' }), [
    'x.spec.ts defines a new-page helper; use apps/web/e2e/lib/',
  ]);
});

test('a test that stops silently in one project is caught', () => {
  assert.deepEqual(violations({ 'x.spec.ts': 'if (!isA11y()) return;' }), [
    'x.spec.ts defines a silent project return; use apps/web/e2e/lib/',
  ]);
});

test('a copied helper is caught', () => {
  assert.deepEqual(violations({ 'x.spec.ts': 'async function login(page) {}\nconsole.log(1);' }), [
    'x.spec.ts defines a login helper; use apps/web/e2e/lib/',
    'x.spec.ts defines console output; use apps/web/e2e/lib/',
  ]);
});

test('a project check, an API address and a fixed wait are caught', () => {
  const source = [
    "test.skip(test.info().project.name !== 'a11y', 'x');",
    "await request.post(`${process.env['E2E_API_URL']}/v1/x`);",
    'await page.waitForTimeout(3200);',
  ].join('\n');
  assert.deepEqual(violations({ 'x.spec.ts': source }), [
    'x.spec.ts defines a project check; use apps/web/e2e/lib/',
    'x.spec.ts defines an API address or key; use apps/web/e2e/lib/',
    'x.spec.ts defines a fixed wait; use apps/web/e2e/lib/',
  ]);
  assert.deepEqual(
    violations({ 'y.spec.ts': 'const slug = `x-${test.info().project.name}`;' }),
    []
  );
});
