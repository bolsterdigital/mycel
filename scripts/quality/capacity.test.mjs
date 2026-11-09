// Tail cells disappeared when a growing corpus shared one six-minute measurement step.
// Prove coverage and bounded serial work together; extending the deadline hides growth.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { matrix, selectRoutes } from './matrix.mjs';
import { sourceContract, expectedShards } from './evidence.mjs';

const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(source('apps/web/e2e/quality-corpus.json'));
const contract = (matrixSource = source('scripts/quality/matrix.mjs')) =>
  sourceContract({
    corpus: JSON.stringify(manifest),
    seed: source('scripts/e2e/e2e.mjs'),
    matrixSource,
    workflow: source('.github/workflows/frontend-quality.yml'),
    lock: source('package-lock.json'),
  });

test('full matrix bounds each serial shard while retaining every original cell exactly once', () => {
  const old = source('scripts/quality/fixtures/pre-partition/matrix.source');
  for (const event of ['schedule', 'workflow_dispatch']) {
    const before = expectedShards(contract(old), event);
    const after = expectedShards(contract(), event);
    assert.ok(after.every((shard) => shard.ids.length > 0 && shard.ids.length <= 2));
    const ids = after.flatMap((shard) => shard.ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids.sort(), before.flatMap((shard) => shard.ids).sort());
    assert.equal(new Set(after.map((shard) => shard.name)).size, after.length);
    for (const shard of matrix(event).include) {
      const entries =
        shard.scope === 'admin'
          ? manifest.admin.routes
          : Object.entries(manifest.public)
              .filter(([, entry]) => (entry.set ?? 'default') === shard.scope)
              .map(([name]) => ({ name, indexable: true }));
      assert.deepEqual(
        selectRoutes(entries, shard.scope, shard.routes).map((entry) => entry.name),
        shard.routes.split(',')
      );
    }
  }
  for (const event of ['pull_request', 'push', 'merge_group'])
    assert.deepEqual(expectedShards(contract(), event), expectedShards(contract(old), event));
});

test('route selection rejects missing, duplicate and cross-scope routes', () => {
  const entries = [
    { name: 'campaign', indexable: true },
    { name: 'native-editor', indexable: false },
  ];
  assert.deepEqual(selectRoutes(entries, 'admin', 'native-editor'), [entries[1]]);
  assert.deepEqual(selectRoutes(entries, 'default', ''), entries);
  for (const routes of [
    'missing',
    'native-editor,missing',
    'native-editor,native-editor',
    'campaign',
  ])
    assert.throws(() => selectRoutes(entries, 'admin', routes));
});

test('workflow selects its routes and gives every retained shard a unique expected name', () => {
  const workflow = source('.github/workflows/frontend-quality.yml');
  const template = /name: (quality-summary-.+)$/m.exec(workflow)?.[1];
  assert.ok(template);
  assert.match(workflow, /npm run quality -- --route=\$\{\{ matrix.routes \}\}/);
  assert.match(workflow, /id: measurement\n        timeout-minutes: 6/);
  const render = (template, shard) =>
    template.replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
      String(
        runInNewContext(expression, {
          matrix: shard,
          format: (pattern, part) => pattern.replace('{0}', part),
        })
      )
    );
  for (const event of ['pull_request', 'schedule', 'workflow_dispatch']) {
    const actual = matrix(event).include.map((shard) => render(template, shard));
    assert.equal(new Set(actual).size, actual.length);
    assert.deepEqual(
      actual,
      expectedShards(contract(), event).map((shard) => shard.name)
    );
  }
});
