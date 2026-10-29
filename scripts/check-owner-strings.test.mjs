// Negative fixtures for check-owner-strings.mjs: each directory under fixtures/owner-strings/
// breaks one rule and must fail with its own message; `good` holds the look-alikes that must pass
// (an npm `dev` script, a lane name in data rather than code, a CI runner's home, the Dutch word
// `proef` in copy, the excluded CLAUDE.md). The last
// test runs the gate on this repository. Run by `npm run lint:infra` through `node --test`.

import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('check-owner-strings.mjs', import.meta.url));
const fixture = (name) => fileURLToPath(new URL(`fixtures/owner-strings/${name}`, import.meta.url));
const check = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('look-alikes and excluded files pass', () => {
  const run = check('--root', fixture('good'));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /owner strings ok \(0 allowlisted/);
});

const failing = {
  'home-path': 'docs/notes.md:3: personal home path',
  'linux-home': 'scripts/paths.mjs:1: personal home path',
  'any-home': 'scripts/paths.mjs:1: personal home path',
  'lane-markdown': 'docs/notes.md:3: planning lane word',
  'lane-yaml': '.github/ci.yml:1: planning lane word',
  trial: 'apps/web/src/save.ts:1: private trial reference',
  'planning-sibling': 'packages/core/src/plans.ts:1: private planning sibling',
  'model-mode': 'tools/run.mjs:1: owner agent tooling',
  'shared-task': '.github/claim.mjs:1: owner agent tooling',
  'lane-mbp': 'apps/web/src/lane.ts:1: planning lane word',
  'lane-owner-dev': 'scripts/route.mjs:1: planning lane literal',
  'stale-allowlist':
    'scripts/owner-strings.allowlist.json: tools/run.mjs has no violation any more; remove the entry',
};

for (const [name, message] of Object.entries(failing))
  test(`${name} fails`, () => {
    const run = check('--root', fixture(name));
    assert.equal(run.status, 1, run.stdout);
    assert.ok(run.stderr.includes(message), `expected "${message}" in:\n${run.stderr}`);
    // One broken rule, one message: the fixture tests that rule and nothing else.
    assert.equal(run.stderr.trim().split('\n').length, 2, run.stderr);
  });

test('an allowlisted violation is tolerated and counted', () => {
  const run = check('--root', fixture('allowlisted'));
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /owner strings ok \(1 allowlisted/);
});

test('this repository carries no owner strings outside the allowlist', () => {
  const run = check();
  assert.equal(run.status, 0, run.stderr);
});
