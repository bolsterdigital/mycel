// Every provider adapter tests against provider answers kept as files (testing.md, adapter
// contract): a package whose source calls `fetch` has `fixtures/*.json` and a test that reads
// from that directory. Inline `{ emails: [{ id: 'tem-1' }] }` answers drift from what the
// provider sends; a file is reviewed once and replaced by a recording when one is taken.
// Fronts, the database package and observability call fetch too but are not provider adapters.
// Run by `npm run lint:infra`, offline.
// Rejected: an opt-in marker in package.json, which a new adapter can simply omit, and checking
// every package, which would demand JSON fixtures from blob and media-sharp (their inputs are a
// directory and images, already under their own fixtures).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** Workspaces that use fetch without being a provider adapter (docs/architecture/overview.md). */
export const NOT_ADAPTERS = new Set(['api', 'core', 'db', 'mcp', 'observability']);

const isTest = (path) => /\.test\.[cm]?[jt]s$/.test(path);

/**
 * The adapters that break the rule, given `{ name, files: [{ path, text }], fixtures: [path] }`
 * per package (paths relative to the package).
 */
export function missingFixtures(packages) {
  return packages.flatMap(({ name, files, fixtures }) => {
    if (NOT_ADAPTERS.has(name)) return [];
    const source = files.filter((f) => !isTest(f.path));
    if (!source.some((f) => /\bfetch\b/.test(f.text))) return [];
    if (!fixtures.some((path) => path.endsWith('.json')))
      return [`packages/${name}: calls fetch but has no fixtures/*.json`];
    if (!files.some((f) => isTest(f.path) && /fixtures\//.test(f.text)))
      return [`packages/${name}: has fixtures but no test reads from fixtures/`];
    return [];
  });
}

const root = fileURLToPath(new URL('../packages', import.meta.url));

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, base);
    return [path.slice(base.length + 1)];
  });
}

function workspaces() {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, 'src')))
    .map(({ name }) => {
      const src = join(root, name, 'src');
      const fixturesDir = join(root, name, 'fixtures');
      return {
        name,
        files: walk(src)
          .filter((path) => /\.[cm]?[jt]s$/.test(path))
          .map((path) => ({ path, text: readFileSync(join(src, path), 'utf8') })),
        fixtures: existsSync(fixturesDir) ? walk(fixturesDir) : [],
      };
    });
}

test('every provider adapter tests against fixture files', () => {
  const found = workspaces();
  assert.ok(
    found.some((p) => p.name === 'mail-tem'),
    'the scan finds the TEM adapter'
  );
  assert.deepEqual(missingFixtures(found), []);
});

test('the rule flags an adapter with inline answers and one whose fixtures no test reads', () => {
  const adapter = (name, testText, fixtures) => ({
    name,
    files: [
      { path: 'index.ts', text: 'const res = await fetch(url);' },
      { path: 'index.test.ts', text: testText },
    ],
    fixtures,
  });
  assert.deepEqual(
    missingFixtures([
      adapter('mollie', "Response.json({ id: 'tr_1' })", []),
      adapter('mailchimp', "Response.json({ id: 'x' })", ['member.json']),
      adapter('tem', "readFileSync(new URL('../fixtures/send.json', import.meta.url))", [
        'send.json',
      ]),
      adapter('api', 'no fixtures here', []),
      { name: 'blob', files: [{ path: 'fs.ts', text: 'writeFile()' }], fixtures: [] },
    ]),
    [
      'packages/mollie: calls fetch but has no fixtures/*.json',
      'packages/mailchimp: has fixtures but no test reads from fixtures/',
    ]
  );
});
