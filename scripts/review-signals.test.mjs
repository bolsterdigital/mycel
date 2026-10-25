// Keeps docs/architecture/review-profile.json honest (every path pattern still matches a tracked
// file, every ADR and gate it names exists, every lens has the fields the reviewer reads) and
// pins the routing of scripts/review-signals.mjs with small file lists, so the review method in
// docs/architecture/review.md cannot rot silently. Part of `npm run lint:infra`, offline.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { globToRegExp, loadProfile, render, route } from './review-signals.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const profile = loadProfile();
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const STATUSES = ['mandatory', 'pilot', 'manual', 'inactive'];

test('globs: ** crosses directories, * stays within one', () => {
  assert.ok(globToRegExp('packages/db/migrations/**').test('packages/db/migrations/0001_x.sql'));
  assert.ok(globToRegExp('**/*.spec.ts').test('apps/web/e2e/signup.spec.ts'));
  assert.ok(globToRegExp('**/*.spec.ts').test('a.spec.ts'));
  assert.ok(
    globToRegExp('packages/core/src/*/service.ts').test('packages/core/src/forms/service.ts')
  );
  assert.ok(
    !globToRegExp('packages/core/src/*/service.ts').test('packages/core/src/a/b/service.ts')
  );
  assert.ok(globToRegExp('compose*.yml').test('compose.ci.yml'));
  assert.ok(!globToRegExp('compose*.yml').test('docker/compose.yml'));
});

test('every lens is complete and its status is one the method knows', () => {
  for (const lens of profile.lenses) {
    for (const field of [
      'id',
      'title',
      'status',
      'question',
      'paths',
      'adrs',
      'gates',
      'counterproof',
    ])
      assert.ok(lens[field] !== undefined && lens[field].length > 0, `${lens.id}: ${field}`);
    assert.ok(STATUSES.includes(lens.status), `${lens.id}: status ${lens.status}`);
  }
  assert.equal(
    profile.lenses.filter((l) => l.status === 'mandatory').length,
    1,
    'security is the one mandatory lens'
  );
  assert.equal(
    new Set(profile.lenses.map((l) => l.id)).size,
    profile.lenses.length,
    'ids are unique'
  );
});

test('every ADR and gate the profile names exists', () => {
  const missing = [];
  for (const lens of profile.lenses) {
    for (const adr of lens.adrs)
      if (!tracked.some((f) => f.startsWith(`docs/adr/${adr}-`)))
        missing.push(`${lens.id}: ADR ${adr}`);
    for (const gate of lens.gates)
      if (!existsSync(join(root, gate))) missing.push(`${lens.id}: gate ${gate}`);
  }
  assert.deepEqual(missing, []);
});

test('every path pattern still matches a tracked file', () => {
  const dead = [];
  const sets = [
    ...profile.lenses.map((l) => [l.id, l.paths]),
    ...profile.flags.map((f) => [`flag ${f.id}`, f.paths]),
    ['informational', profile.informational],
  ];
  for (const [name, patterns] of sets)
    for (const p of patterns)
      if (!tracked.some((f) => globToRegExp(p).test(f))) dead.push(`${name}: ${p}`);
  assert.deepEqual(dead, []);
});

test('a migration routes to security first and raises the migration flag', () => {
  const r = route(['packages/db/migrations/0021_x.sql', 'packages/db/src/jobs.ts'], profile);
  assert.equal(r.verdict, 'route');
  assert.equal(r.lenses[0].id, 'security');
  assert.ok(r.lenses.some((l) => l.id === 'reliability'));
  assert.deepEqual(
    r.flags.map((f) => f.id),
    ['migration']
  );
  assert.deepEqual(r.unmapped, []);
});

test('a changed use case raises the registry flag and the contract lens', () => {
  const r = route(['packages/core/src/forms/service.ts'], profile);
  assert.ok(r.lenses.some((l) => l.id === 'contract'));
  assert.ok(r.flags.some((f) => f.id === 'registry'));
});

test('the quality corpus is reviewed as frontend evidence', () => {
  const r = route(['apps/web/e2e/quality-corpus.json'], profile);
  assert.equal(r.verdict, 'route');
  assert.ok(r.lenses.some((l) => l.id === 'frontend'));
  assert.deepEqual(r.unmapped, []);
});

test('a weakened test is a flag even when its module maps to no lens', () => {
  const r = route(['packages/core/src/util/x.test.ts'], profile);
  assert.equal(r.verdict, 'route');
  assert.deepEqual(
    r.flags.map((f) => f.id),
    ['test-surface']
  );
  assert.deepEqual(r.unmapped, []);
});

test('a file the profile does not know makes the verdict needs review', () => {
  const r = route(['packages/core/src/util/new-thing.ts', 'README.md'], profile);
  assert.equal(r.verdict, 'needs review');
  assert.deepEqual(r.unmapped, ['packages/core/src/util/new-thing.ts']);
  assert.deepEqual(r.informational, ['README.md']);
});

test('documentation alone changes no behaviour', () => {
  const r = route(['docs/reference/media.md', 'CHANGELOG.md'], profile);
  assert.equal(r.verdict, 'no behaviour change');
  assert.deepEqual(r.lenses, []);
});

test('an ADR is a flag and a doctrine change, not informational', () => {
  const r = route(['docs/adr/021-x.md'], profile);
  assert.equal(r.verdict, 'route');
  assert.deepEqual(
    r.flags.map((f) => f.id),
    ['adr']
  );
  assert.deepEqual(r.informational, []);
});

test('the rendered block names the verdict, the lens and the gates', () => {
  const text = render(route(['packages/db/migrations/0021_x.sql'], profile), {
    base: 'main',
    head: 'x',
  });
  assert.match(text, /Verdict: \*\*route\*\*/);
  assert.match(text, /Security, privacy and public values/);
  assert.match(text, /rls\.conformance\.test\.ts/);
  assert.match(text, /Flag `migration`/);
});
