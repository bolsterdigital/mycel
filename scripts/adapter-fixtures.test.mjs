// Every provider adapter tests against provider answers kept as files (testing.md, adapter
// contract): a package whose source calls `fetch` has `fixtures/*.json` and a test that reads
// from that directory. Inline `{ emails: [{ id: 'tem-1' }] }` answers drift from what the
// provider sends; a file is reviewed once and replaced by a recording when one is taken.
// Fronts, the database package and observability call fetch too but are not provider adapters.
// Run by `npm run lint:infra`, offline.
// Rejected: an opt-in marker in package.json, which a new adapter can simply omit, and checking
// every package, which would demand JSON fixtures from blob and media-sharp (their inputs are a
// directory and images, already under their own fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTest, readAll, staleEntries, walk, workspaces } from './lib/repo.mjs';

/** Workspaces that use fetch without being a provider adapter (docs/architecture/overview.md). */
export const NOT_ADAPTERS = new Set(['api', 'core', 'db', 'mcp', 'observability']);

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

/** `{ name, files, fixtures }` per package, paths relative to the package. */
const packages = () =>
  workspaces()
    .filter((ws) => ws.startsWith('packages/'))
    .map((ws) => {
      const local = (path) => path.slice(ws.length + 1);
      return {
        name: ws.slice('packages/'.length),
        files: readAll(walk(`${ws}/src`, { match: (p) => /\.[cm]?[jt]s$/.test(p) })).map(
          ({ path, text }) => ({ path: local(path).slice('src/'.length), text })
        ),
        fixtures: walk(`${ws}/fixtures`).map((p) => local(p).slice('fixtures/'.length)),
      };
    })
    .filter(({ files }) => files.length > 0);

/** Names in `NOT_ADAPTERS` that are no package any more. */
const unusedNames = (found) =>
  staleEntries(NOT_ADAPTERS, (name) => found.some((p) => p.name === name), 'NOT_ADAPTERS');

test('every provider adapter tests against fixture files', () => {
  const found = packages();
  assert.ok(
    found.some((p) => p.name === 'mail-tem'),
    'the scan finds the TEM adapter'
  );
  assert.deepEqual(missingFixtures(found), []);
  assert.deepEqual(unusedNames(found), []);
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
