// The measurement workflow must retain invalid/missing states and expand the same matrix for
// scheduled and manual runs. These are contract tests, not snapshots of the implementation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { protectReports } from './protect.mjs';
import { compareBaseline } from './baseline.mjs';
import { IdentityGatherer, IdentityAudit } from './gatherer.mjs';
import { matrix } from './matrix.mjs';
import { status } from './status.mjs';

test('PR set covers both public profiles; scheduled/manual expand locale, cache and admin', () => {
  const pr = matrix('pull_request').include;
  assert.equal(pr.length, 2);
  assert.deepEqual(new Set(pr.map((cell) => cell.profile)), new Set(['mobile', 'desktop']));
  assert.deepEqual(matrix('schedule'), matrix('workflow_dispatch'));
  for (const scope of ['default', 'admin'])
    for (const locale of ['nl', 'en'])
      for (const profile of ['mobile', 'desktop'])
        assert.ok(
          matrix('schedule').include.some(
            (c) => c.scope === scope && c.locale === locale && c.profile === profile
          )
        );
  assert.ok(matrix('schedule').include.some((c) => c.cache === 'warm'));
});
test('calibration keeps raw fail visible, deadline blocks fail/inconclusive/missing', () => {
  for (const state of ['fail', 'inconclusive', 'not-measured']) {
    const report = { state, cells: [{}] };
    assert.equal(status(report, 'failure', '2026-10-26').measured, state);
    assert.equal(status(report, 'failure', '2026-11-09').blocks, true);
  }
  assert.equal(status(undefined, 'failure', '2026-11-09').blocks, true);
  assert.equal(status({ state: 'pass', cells: [{}] }, 'success', '2026-11-09').blocks, false);
  assert.equal(status({ state: 'pass', cells: [] }, 'success', '2026-11-09').blocks, true);
});
test('quality proxy preserves production compression and closed operational paths', () => {
  const production = readFileSync(new URL('../../docker/caddy/Caddyfile', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('./run.mjs', import.meta.url), 'utf8');
  for (const directive of [
    'encode zstd gzip',
    '@internal path /internal/* /readyz /metrics',
    'respond @internal 404',
  ]) {
    assert.ok(production.includes(directive));
    assert.ok(runner.includes(directive));
  }
  const workflow = readFileSync(
    new URL('../../.github/workflows/frontend-quality.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /timeout-minutes: 10/);
  assert.match(workflow, /if: always\(\)/);
  assert.doesNotMatch(workflow, /path: .*\/private\s*$/m);
});

test('pinned Lighthouse loads the identity extension', () => {
  assert.ok(new IdentityGatherer().meta.supportedModes.includes('navigation'));
  assert.deepEqual(IdentityAudit.meta.requiredArtifacts, ['MycelIdentity']);
});

test('authenticated originals survive public-key encryption and round-trip locally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mycel-private-report-'));
  try {
    mkdirSync(join(dir, 'private'));
    writeFileSync(join(dir, 'private', 'sample.json'), '{"synthetic":"private"}');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=test',
      ],
      { stdio: 'ignore' }
    );
    protectReports(dir, join(dir, 'cert.pem'));
    execFileSync('openssl', [
      'cms',
      '-decrypt',
      '-binary',
      '-inform',
      'DER',
      '-in',
      join(dir, 'private.tar.gz.cms'),
      '-inkey',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'decrypted.tar.gz'),
    ]);
    const text = execFileSync(
      'tar',
      ['-xOzf', join(dir, 'decrypted.tar.gz'), 'private/sample.json'],
      { encoding: 'utf8' }
    );
    assert.equal(text, '{"synthetic":"private"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('failed or mismatched baselines cannot redefine absolute acceptance', () => {
  const current = { fixtureHash: 'a', environment: { lighthouse: '13.5.0' }, cells: [] };
  assert.equal(compareBaseline(current).state, 'no baseline');
  assert.equal(compareBaseline(current, { ...current, state: 'fail' }).state, 'no baseline');
  assert.equal(
    compareBaseline(current, { ...current, state: 'pass', fixtureHash: 'b' }).state,
    'no baseline'
  );
  assert.equal(
    compareBaseline(current, { ...current, state: 'pass', commit: 'previous' }).state,
    'compared'
  );
});
