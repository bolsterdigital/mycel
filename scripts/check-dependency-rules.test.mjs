// Negative fixtures for check-dependency-rules.mjs (TODO #20c decision 7): each repo under
// fixtures/dependency-rules/ breaks one rule and must fail with its own message; `good` exercises
// every allowed form (comments and strings that look like imports, an in-workspace relative path,
// SPDX OR, AND and WITH) and must pass. Run by `npm run lint:deps` through `node --test`.

import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('check-dependency-rules.mjs', import.meta.url));
const fixture = (name) =>
  fileURLToPath(new URL(`fixtures/dependency-rules/${name}`, import.meta.url));
const check = (name) =>
  spawnSync(process.execPath, [script, '--root', fixture(name)], { encoding: 'utf8' });

test('a repo that keeps every rule passes', () => {
  const run = check('good');
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /dependency rules ok \(3 workspaces\)/);
});

const failing = {
  'static-import': 'apps/web/src/index.ts: imports @fx/db (not allowed from apps/web)',
  'dynamic-import': 'apps/web/src/index.ts: imports @fx/db (not allowed from apps/web)',
  require: 'apps/web/src/index.cjs: imports @fx/db (not allowed from apps/web)',
  'export-from': 'apps/web/src/index.ts: imports @fx/db (not allowed from apps/web)',
  'svelte-script': 'apps/web/src/Page.svelte: imports @fx/db (not allowed from apps/web)',
  'relative-import':
    'apps/web/src/index.ts: relative import ../../../packages/core/src/index.js leaves apps/web',
  'io-in-core': 'packages/core/src/index.ts: core imports I/O library node:fs (ADR 001)',
  'licence-and': 'dependency mixed@1.0.0: licence MIT AND GPL-2.0-only not in allow-list',
  'licence-unknown':
    'dependency mystery@1.0.0: licence SEE LICENSE IN LICENSE.txt not in allow-list',
  'workspace-licence': 'packages/db/package.json: license must be AGPL-3.0-only',
};

for (const [name, message] of Object.entries(failing))
  test(`${name} fails`, () => {
    const run = check(name);
    assert.equal(run.status, 1, run.stdout);
    assert.ok(run.stderr.includes(message), `expected "${message}" in:\n${run.stderr}`);
    // One broken rule, one message: the fixture tests that rule and nothing else.
    assert.equal(run.stderr.trim().split('\n').length, 2, run.stderr);
  });
