// The measurement workflow must retain invalid/missing states and expand the same matrix for
// scheduled and manual runs. These are contract tests, not snapshots of the implementation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { protectReports } from './protect.mjs';
import { compareBaseline } from './baseline.mjs';
import { IdentityGatherer, IdentityAudit } from './gatherer.mjs';
import { matrix } from './matrix.mjs';
import { status as qualityStatus } from './status.mjs';

test('PR set covers both public profiles; scheduled/manual expand locale, cache and admin', () => {
  const pr = matrix('pull_request').include;
  assert.equal(pr.length, 2);
  assert.deepEqual(new Set(pr.map((cell) => cell.profile)), new Set(['mobile', 'desktop']));
  assert.deepEqual(matrix('schedule'), matrix('workflow_dispatch'));
  // The merge queue measures what the PR measured, never less and never the full set.
  assert.deepEqual(matrix('merge_group'), matrix('pull_request'));
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
  const dated = { deadline: '2026-11-09T00:00:00Z', earlyActivation: null };
  const status = (report, outcome, now, policy = dated) =>
    qualityStatus(report, outcome, now, policy);
  for (const state of ['fail', 'inconclusive', 'not-measured']) {
    const report = { state, cells: [{}] };
    assert.equal(status(report, 'failure', '2026-10-26').measured, state);
    assert.equal(status(report, 'failure', '2026-11-09').blocks, true);
  }
  assert.equal(status(undefined, 'failure', '2026-11-09').blocks, true);
  assert.equal(status({ state: 'pass', cells: [{}] }, 'success', '2026-11-09').blocks, false);
  assert.equal(status({ state: 'pass', cells: [] }, 'success', '2026-11-09').blocks, true);
  const suspended = { deadline: null, earlyActivation: null };
  assert.equal(status(undefined, 'failure', '2030-01-01', suspended).blocks, false);
  assert.equal(status(undefined, 'failure', '2030-01-01', suspended).measured, 'not-measured');
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

test('measured writer DOM passes the same identity path; wrong article and empty prose fail', async (t) => {
  const { chromium } = await import('@playwright/test');
  const { existsSync } = await import('node:fs');
  if (!existsSync(chromium.executablePath())) {
    if (process.env.CI) throw new Error('Chromium required for measured writer regression');
    return t.skip('Playwright Chromium is not installed');
  }
  const { validateIdentity, writerExpectation } = await import('./identity.mjs');
  const blocks = [
    {
      id: 'prose-id',
      type: 'rich-text',
      props: {
        content: {
          nl: {
            type: 'doc',
            content: [
              { type: 'heading', content: [{ type: 'text', text: 'Een gedeelde straat' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Bewoners bespreken bomen.' }] },
            ],
          },
        },
      },
    },
    { id: 'image-id', type: 'image', props: {} },
  ];
  const expected = {
    url: 'about:blank',
    locale: 'nl',
    title: '',
    indexable: false,
    item: true,
    writer: true,
    writerBlocks: writerExpectation({ blocks }, 'nl'),
  };
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    // Same structure as article-extensions.ts: the writer h1 is generic, prose and opaque
    // cards carry stable block ids; document.title is absent from the visible body.
    await page.setContent(`<html lang="nl"><head><meta name="robots" content="noindex"></head>
      <body><span class="admin-site-name">Probe</span><form action="/admin/logout"></form>
      <main><h1>Artikel schrijven</h1><div class="writing-surface"><div class="ProseMirror">
      <section data-mycel-prose data-block-id="prose-id"><h2>Een gedeelde straat</h2>
      <p>Bewoners bespreken bomen.</p></section>
      <div data-mycel-card data-block-id="image-id" data-block-type="image">image</div>
      </div></div></main></body></html>`);
    const gather = () =>
      new IdentityGatherer().getArtifact({
        driver: {
          executionContext: { evaluate: (callback) => page.evaluate(callback) },
        },
      });
    const check = async () =>
      validateIdentity(expected, {
        ...(await gather()),
        status: 200,
        csp: true,
        privateCache: true,
      });
    assert.equal((await check()).valid, true);
    await page
      .locator('[data-mycel-prose]')
      .evaluate((node) => node.setAttribute('data-block-id', 'wrong'));
    assert.ok((await check()).reasons.includes('wrong-item'));
    await page.locator('[data-mycel-prose]').evaluate((node) => {
      node.setAttribute('data-block-id', 'prose-id');
      node.textContent = '';
    });
    assert.ok((await check()).reasons.includes('empty-editor'));
  } finally {
    await browser.close();
  }
});

// The validator grows this existing suite: score fixtures remain the evaluator's contract;
// these cases cover the evidence boundary that a green observation job cannot prove.
import { consumeRun, sourceContract, expectedShards } from './evidence.mjs';
const clock = '2026-10-27T12:00:00Z';
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const contract = sourceContract({
  corpus: source('apps/web/e2e/quality-corpus.json'),
  seed: source('scripts/e2e/e2e.mjs'),
  matrixSource: source('scripts/quality/matrix.mjs'),
  workflow: source('.github/workflows/frontend-quality.yml'),
  lock: source('package-lock.json'),
});
function retained(event = 'workflow_dispatch') {
  const run = {
    id: 123,
    attempt: 1,
    event,
    headSha: 'a'.repeat(40),
    measuredSha: 'a'.repeat(40),
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-10-26T18:00:00Z',
    url: 'https://github.com/bolsterdigital/mycel/actions/runs/123',
    contract,
    artifacts: [],
  };
  for (const shard of expectedShards(contract, event)) {
    const { ids, name, ...profile } = shard;
    run.artifacts.push({
      name,
      id: run.artifacts.length + 1,
      report: {
        schemaVersion: 1,
        commit: run.measuredSha,
        fixtureVersion: contract.fixtureVersion,
        fixtureHash: contract.fixtureHash,
        state: 'pass',
        environment: {
          ...profile,
          ...contract.tools,
          chromium: '156.0.8078.4',
          caddy: `v${contract.tools.caddy} test`,
          runner: `github-container:${contract.runnerImage}`,
          hostImage: '20261023.334.3',
          kernel: '6.11.0-1018-azure',
          mode: 'ci',
        },
        coverage: [
          {
            route: 'dynamic POST/iframe preview',
            state: 'not-measured',
            address: '#43B',
            reason: 'PRIVATE secret@invalid.test',
          },
        ],
        cells: ids.map((id) => ({
          id,
          route:
            'https://localhost:4443' +
            (Object.entries(contract.manifest.public).find(
              ([name]) => id === `${name}-${shard.locale}-${shard.profile}-${shard.cache}`
            )?.[1].locales[shard.locale].path ??
              contract.manifest.admin.routes
                .find(
                  (entry) => id === `${entry.name}-${shard.locale}-${shard.profile}-${shard.cache}`
                )
                .path.replace('{quality-article-id}', 'a'.repeat(36))),
          profile: shard.profile,
          locale: shard.locale,
          cache: shard.cache,
          indexable: shard.scope !== 'admin',
          state: 'pass',
          batches: [
            {
              state: 'pass',
              sampleIds: [1, 2, 3, 4, 5].map((n) => `${id}-${n}`),
              reasons: [],
              failedAuditIds: [],
              raw: Array.from({ length: 5 }, () => ({
                performance: 1,
                accessibility: 1,
                'best-practices': 1,
                seo: 1,
              })),
              performance: { median: 1, min: 1, max: 1 },
            },
          ],
        })),
      },
    });
  }
  return run;
}
const load = (a) => a.report;
test('consumer counts the versioned full matrix and retains all red observation batches', () => {
  const run = retained();
  const bad = run.artifacts[0].report.cells[0];
  bad.state = bad.batches[0].state = 'fail';
  bad.batches[0].reasons = ['page-identity:wrong-item'];
  bad.batches.push(structuredClone(bad.batches[0]));
  bad.batches[1].state = 'pass';
  bad.batches[1].reasons = [];
  const result = consumeRun(run, load);
  assert.equal(result.expected, 48);
  assert.equal(result.samples, 245);
  assert.equal(result.state, 'fail');
  assert.equal(result.conclusion, 'success');
  assert.equal(result.cells[0].batches.length, 2);
  assert.equal(result.proposals[0].key, 'page-identity:wrong-item');
  assert.equal(result.proposals[0].category, 'measurement');
  assert.deepEqual(result.proposals[0].claims, []);
  assert.equal(result.coverage[0].sourceAddress, '#43B');
  assert.equal('address' in result.coverage[0], false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret@/);
});
test('missing, duplicate, corrupt, interrupted and mismatched evidence can never pass', () => {
  for (const mutate of [
    (r) => r.artifacts.pop(),
    (r) => {
      r.headSha = 'b'.repeat(40);
    },
    (r) => r.artifacts[0].report.cells.pop(),
    (r) => r.artifacts.push(structuredClone(r.artifacts[0])),
    (r) => r.artifacts[0].report.cells.push(structuredClone(r.artifacts[0].report.cells[0])),
    (r) => {
      r.artifacts[0].report.cells[0].route = 'https://localhost:4443/login';
    },
    (r) => {
      r.artifacts[0].report.commit = 'b'.repeat(40);
    },
    (r) => {
      r.artifacts[0].report.fixtureHash = 'b'.repeat(64);
    },
    (r) => {
      r.artifacts[0].report.environment.profile = 'desktop';
    },
    (r) => {
      r.artifacts[0].report.environment.chromium = '1.2.3';
    },
    (r) => {
      r.artifacts[0].report = null;
    },
    (r) => {
      r.artifacts[0].error = 'unavailable';
    },
    (r) => {
      r.status = 'cancelled';
    },
    (r) => {
      r.artifacts[0].report.interrupted = true;
    },
    (r) => {
      r.artifacts[0].report.cells[0].batches[0].raw[0].accessibility = 0.98;
    },
    (r) => {
      r.artifacts[0].report.cells[0].batches[0].sampleIds.pop();
    },
  ]) {
    const run = retained();
    mutate(run);
    const result = consumeRun(run, load);
    assert.notEqual(result.state, 'pass');
    assert.ok(result.issues.length);
  }
});
test('cancelled attempts cannot pass, and local evidence keeps its own kind', () => {
  const run = retained();
  run.conclusion = 'cancelled';
  assert.notEqual(consumeRun(run, load).state, 'pass');
  const local = retained('push');
  local.event = 'local';
  local.selection = { scope: 'default', locale: 'nl', profile: 'mobile', cache: 'fresh' };
  local.artifacts = local.artifacts.slice(0, 1);
  Object.assign(local.artifacts[0].report.environment, {
    mode: 'local',
    runner: 'local:linux:test',
  });
  const output = consumeRun(local, load);
  assert.equal(output.state, 'pass');
  assert.equal(output.evidenceKind, 'local');
});

test('a non-pass shard summary cannot be upgraded by its passing available cells', () => {
  for (const state of ['fail', 'inconclusive', 'not-measured']) {
    const run = retained();
    run.artifacts[0].report.state = state;
    assert.equal(consumeRun(run, load).state, state);
  }
});

// The required check consumes real report fixtures, not a matrix job's success colour.
import { gate, enforcement } from './gate.mjs';
// The committed policy may suspend the deadline (null); these fixtures exercise a dated policy.
const policy = {
  ...JSON.parse(source('scripts/quality/enforcement.json')),
  deadline: '2026-11-09T00:00:00Z',
};
function gateFixture(event = 'pull_request') {
  const run = retained(event);
  for (const artifact of run.artifacts)
    artifact.report.workflow = { runId: String(run.id), attempt: String(run.attempt) };
  return {
    run,
    load,
    policy,
    downloadOutcome: 'success',
    now: '2026-11-09T00:00:00Z',
    needs: {
      prepare: { result: 'success', outputs: { matrix: JSON.stringify(matrix(event)) } },
      measure: { result: 'success' },
    },
  };
}
// Original sanitized summaries are kept byte-for-byte; run.json records API/source hashes.
function historicalHostShards() {
  const root = new URL('./fixtures/pr90-host-shards/', import.meta.url);
  const run = JSON.parse(readFileSync(new URL('run.json', root), 'utf8'));
  for (const artifact of run.artifacts) {
    const bytes = readFileSync(new URL(`${artifact.id}.summary`, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.summaryHash);
    artifact.report = JSON.parse(bytes);
  }
  return { ...gateFixture(), run, now: '2026-10-27T18:00:00Z' };
}
test('original PR90 independent-host shards retain all four cells and twenty samples', () => {
  for (const reverse of [false, true]) {
    const input = historicalHostShards();
    if (reverse) input.run.artifacts.reverse();
    const result = gate(input);
    assert.deepEqual(result.issues, []);
    assert.equal(result.report.fixtureVersion, '43a-v3');
    assert.equal(result.report.expected, 4);
    assert.equal(result.report.present, 4);
    assert.equal(result.report.samples, 20);
    assert.equal(result.measured, 'fail');
    assert.equal(result.blocks, false);
    assert.deepEqual(result.report.cells, consumeRun(input.run, load).cells);
    for (const artifact of input.run.artifacts) {
      const retained = result.report.profiles.find((p) => p.artifact === artifact.name);
      for (const field of ['kernel', 'hostImage'])
        assert.equal(retained.environment[field], artifact.report.environment[field]);
      for (const cell of artifact.report.cells) {
        const kept = result.report.cells.find((c) => c.id === cell.id);
        assert.deepEqual(
          kept.batches.map((b) => b.raw),
          cell.batches.map((b) => b.raw)
        );
        assert.equal(kept.state, cell.state);
      }
    }
    assert.equal(gate({ ...input, now: policy.deadline }).blocks, true);
  }
});
test('historical v3 and current v4 shards reject provenance, tool and artifact corruption', () => {
  const mutations = {
    sha: (i) => {
      i.run.artifacts[0].report.commit = 'b'.repeat(40);
    },
    corpus: (i) => {
      i.run.artifacts[0].report.fixtureVersion = '43a-v99';
    },
    hash: (i) => {
      i.run.artifacts[0].report.fixtureHash = 'b'.repeat(64);
    },
    run: (i) => {
      i.run.artifacts[0].report.workflow.runId = '999';
    },
    attempt: (i) => {
      i.run.artifacts[0].report.workflow.attempt = '0';
    },
    missing: (i) => {
      i.run.artifacts.pop();
    },
    corrupt: (i) => {
      i.load = () => {
        throw new Error('corrupt JSON');
      };
    },
    samples: (i) => {
      i.run.artifacts[0].report.cells[0].batches[0].sampleIds.pop();
    },
  };
  for (const field of ['runner', 'node', 'lighthouse', 'playwright', 'chromium', 'caddy'])
    mutations[field] = (i) => {
      i.run.artifacts[1].report.environment[field] += '-changed';
    };
  for (const fixture of [historicalHostShards, gateFixture]) {
    for (const [name, mutate] of Object.entries(mutations)) {
      const input = fixture();
      mutate(input);
      for (const now of ['2026-10-27T18:00:00Z', policy.deadline]) {
        const result = gate({ ...input, now });
        assert.equal(result.blocks, true, name);
        assert.equal(result.measured, 'not-measured', name);
      }
    }
    const input = fixture();
    const forward = gate(input);
    input.run.artifacts.reverse();
    assert.deepEqual(gate(input).report.tools, forward.report.tools);
    // Host-image identity stays strict for legacy evidence in either shard order.
    input.run.contract = { ...input.run.contract };
    delete input.run.contract.runnerImage;
    for (const [n, artifact] of input.run.artifacts.entries())
      artifact.report.environment.runner = `github-ubuntu-24.04:2026102${n}.354.1`;
    assert.equal(gate(input).blocks, true);
    input.run.artifacts.reverse();
    assert.equal(gate(input).blocks, true);
  }
});
test('container shards bind immutable userspace and tools while retaining independent hosts', () => {
  const input = gateFixture();
  const digest = 'd65108d1a8095d8b0c4a5e32bf1807a40a5ce90ff0c78473e1116b1c243235e8';
  input.run.contract = { ...input.run.contract, runnerImage: `sha256:${digest}` };
  for (const [n, artifact] of input.run.artifacts.entries()) {
    Object.assign(artifact.report.environment, {
      runner: `github-container:sha256:${digest}`,
      hostImage: ['20261026.354.1', '20261023.334.3'][n],
      kernel: ['6.17.0-1022-azure', '7.0.0-1017-azure'][n],
    });
  }
  const result = gate(input);
  assert.equal(result.blocks, false);
  assert.equal(result.report.present, 6);
  assert.equal(result.report.samples, 30);
  assert.deepEqual(
    result.report.profiles.map((p) => p.environment.hostImage),
    ['20261026.354.1', '20261023.334.3']
  );
  assert.equal('kernel' in result.report.tools, false);
  assert.deepEqual(
    result.report.profiles.map((p) => p.environment.kernel),
    ['6.17.0-1022-azure', '7.0.0-1017-azure']
  );
  for (const field of ['runner', 'node', 'lighthouse', 'playwright', 'chromium', 'caddy']) {
    const bad = { ...input, run: structuredClone(input.run) };
    bad.run.artifacts[1].report.environment[field] += '-changed';
    assert.equal(gate(bad).blocks, true, field);
  }
  for (const field of ['runner', 'kernel', 'hostImage']) {
    const bad = { ...input, run: structuredClone(input.run) };
    delete bad.run.artifacts[1].report.environment[field];
    assert.equal(gate(bad).blocks, true, `missing ${field}`);
  }
  for (const [field, values] of Object.entries({
    kernel: ['unknown', '6.17.0\n', '6.17.0\nforged', '6.17.0/' + 'a'.repeat(240)],
    hostImage: ['unknown', '20261026.354.1\n', '20261026.354.1\nforged', '20261026'],
  })) {
    for (const value of values) {
      const bad = { ...input, run: structuredClone(input.run) };
      bad.run.artifacts[1].report.environment[field] = value;
      assert.equal(gate(bad).blocks, true, `invalid ${field}: ${value}`);
    }
  }
  // Historical host runs keep their original strict image comparison.
  delete input.run.contract.runnerImage;
  for (const a of input.run.artifacts)
    a.report.environment.runner = `github-ubuntu-24.04:${a.report.environment.hostImage}`;
  assert.equal(gate(input).blocks, true);
});
test('measurement installs no mutable host browser dependencies and pins its container to source', () => {
  const workflow = source('.github/workflows/frontend-quality.yml');
  assert.match(
    workflow,
    new RegExp(`playwright:v${contract.tools.playwright}-noble@${contract.runnerImage}`)
  );
  assert.match(workflow, /docker pull "\$QUALITY_RUNNER_IMAGE"/);
  assert.match(workflow, /"\$QUALITY_RUNNER_IMAGE" \\\n\s+npm run quality/);
  assert.match(workflow, /--env "QUALITY_HOST_IMAGE=\$ImageVersion"/);
  assert.match(workflow, /--volume .*\/opt\/quality-node:ro/);
  assert.match(workflow, /--volume \/usr\/local\/bin\/caddy:.*:ro/);
  assert.doesNotMatch(workflow, /playwright install|apt-get|apt-mirrors/);
  const inputs = {
    corpus: source('apps/web/e2e/quality-corpus.json'),
    seed: source('scripts/e2e/e2e.mjs'),
    matrixSource: source('scripts/quality/matrix.mjs'),
    workflow,
    lock: source('package-lock.json'),
  };
  assert.throws(() =>
    sourceContract({ ...inputs, workflow: workflow.replace(/@sha256:[a-f0-9]{64}/, '') })
  );
});
test('required quality context validates complete default and full evidence at the UTC boundary', () => {
  for (const event of ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']) {
    const input = gateFixture(event);
    assert.equal(gate(input).blocks, false);
    assert.equal(gate(input).measured, 'pass');
    for (const state of ['fail', 'inconclusive', 'not-measured']) {
      const changed = gateFixture(event);
      const cell = changed.run.artifacts[0].report.cells[0];
      cell.state = cell.batches[0].state = state;
      changed.run.artifacts[0].report.state = state;
      assert.equal(gate({ ...changed, now: '2026-11-08T23:59:59.999Z' }).blocks, false);
      assert.equal(gate(changed).blocks, true);
      assert.equal(gate(changed).measured, state);
    }
  }
});
test('green observation jobs cannot hide missing, stale, corrupt or contradictory matrix evidence', () => {
  const mutations = [
    (i) => {
      i.downloadOutcome = 'failure';
    },
    (i) => {
      i.run.artifacts = [];
    },
    (i) => {
      i.run.artifacts.pop();
    },
    (i) => {
      i.run.artifacts[0].report.cells.pop();
    },
    (i) => {
      i.run.artifacts[0].report.cells = [];
    },
    (i) => {
      i.run.artifacts.push(structuredClone(i.run.artifacts[0]));
    },
    (i) => {
      i.run.artifacts[0].report.workflow.attempt = '0';
    },
    (i) => {
      i.run.artifacts[0].report.workflow.runId = '999';
    },
    (i) => {
      delete i.run.artifacts[0].report.workflow;
    },
    (i) => {
      i.run.artifacts[0].report.commit = 'b'.repeat(40);
    },
    (i) => {
      i.run.artifacts[0].report.fixtureHash = 'b'.repeat(64);
    },
    (i) => {
      i.run.artifacts[0].report.environment.lighthouse = 'unknown';
    },
    (i) => {
      i.run.artifacts[0].report.interrupted = true;
    },
    (i) => {
      i.run.artifacts[0].report.cells[0].batches[0].sampleIds.pop();
    },
    (i) => {
      i.run.artifacts[0].report.cells[0].batches[0].raw[0].accessibility = 0.99;
    },
    (i) => {
      i.load = () => {
        throw new Error('corrupt JSON');
      };
    },
    (i) => {
      i.needs.prepare.outputs.matrix = '{"include":[]}';
    },
    (i) => {
      delete i.needs.prepare.outputs;
    },
    (i) => {
      i.run.event = 'unknown';
    },
  ];
  for (const job of ['prepare', 'measure'])
    for (const result of ['failure', 'cancelled', 'skipped', undefined])
      mutations.push((i) => {
        i.needs[job].result = result;
      });
  for (const [n, mutate] of mutations.entries()) {
    const input = gateFixture();
    mutate(input);
    for (const now of ['2026-10-27T12:00:00Z', '2026-11-09T00:00:00Z']) {
      const result = gate({ ...input, now });
      assert.equal(result.blocks, true, `mutation ${n}, ${now}`);
      assert.equal(result.measured, 'not-measured');
    }
  }
});
test('early enforcement requires an explicit reviewed pair of independent run records', () => {
  const repo = 'example/repo';
  const enforced = (p, at) => enforcement(p, at, repo);
  const early = {
    at: '2026-11-02T12:00:00Z',
    candidateSha: 'a'.repeat(40),
    fixtureHash: 'b'.repeat(64),
    runs: [1, 2].map((n) => `https://github.com/${repo}/actions/runs/${n}`),
    review: `https://github.com/${repo}/pull/90#pullrequestreview-123`,
  };
  const activated = { ...policy, earlyActivation: early };
  // The record is bound to the repository the gate runs in: another slug, or none, refuses it.
  assert.throws(() => enforcement(activated, early.at, 'other/repo'));
  assert.throws(() => enforcement(activated, early.at, undefined));
  assert.equal(enforced(activated, '2026-11-02T11:59:59.999Z'), false);
  assert.equal(enforced(activated, early.at), true);
  const input = gateFixture();
  input.run.artifacts[0].report.state = 'fail';
  assert.equal(gate({ ...input, policy: activated, now: early.at, repository: repo }).blocks, true);
  assert.throws(() => enforced({ ...activated, deadline: '2026-11-01T00:00:00Z' }, early.at));
  assert.throws(() => enforced({ ...policy, deadline: 'soon' }, early.at));
  assert.equal(enforced({ ...policy, deadline: null }, '2030-01-01T00:00:00Z'), false);
  assert.equal(enforced({ ...activated, deadline: null }, early.at), true);
  assert.throws(() => enforced({ ...policy, earlyActivation: {} }, early.at));
  assert.throws(() =>
    enforced(
      { ...policy, earlyActivation: { ...early, runs: [early.runs[0], early.runs[0]] } },
      early.at
    )
  );
});

test('required job always validates after both dependencies and cannot ignore its own failure', () => {
  const workflow = source('.github/workflows/frontend-quality.yml');
  const job = workflow.split('\n  frontend-quality:\n')[1];
  assert.ok(job);
  assert.match(job, /name: frontend-quality\n    if: always\(\)\n    needs: \[prepare, measure\]/);
  assert.match(job, /pattern: quality-summary-\*/);
  assert.match(job, /QUALITY_DOWNLOAD_OUTCOME: \$\{\{ steps.download.outcome \}\}/);
  const validation = job
    .split('name: Validate expected matrix')[1]
    .split('name: Retain gate evidence')[0];
  assert.match(validation, /if: always\(\)/);
  assert.match(validation, /node scripts\/quality\/gate.mjs/);
  assert.doesNotMatch(validation, /continue-on-error/);
  const protection = JSON.parse(source('.github/main-protection.json'));
  const expected = [
    'verify',
    'security',
    'image',
    'compose',
    'prepare',
    'frontend-quality',
    ...matrix('pull_request').include.map(
      (s) => `measure (${s.scope}, ${s.locale}, ${s.profile}, ${s.cache})`
    ),
  ];
  assert.deepEqual(
    protection.required_status_checks.checks.map((c) => c.context).sort(),
    expected.sort()
  );
  assert.ok(protection.required_status_checks.checks.every((c) => c.app_id === 15368));
  // The merge queue tests each PR on the current main, so the classic `strict` flag stays off;
  // the ruleset carries the queue with the same checks and no bypass.
  assert.equal(protection.required_status_checks.strict, false);
  const ruleset = JSON.parse(source('.github/main-ruleset.json'));
  const rule = (type) => ruleset.rules.find((r) => r.type === type);
  assert.equal(ruleset.enforcement, 'active');
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.equal(rule('merge_queue').parameters.merge_method, 'SQUASH');
  assert.equal(rule('merge_queue').parameters.max_entries_to_merge, 1);
  assert.deepEqual(
    rule('required_status_checks').parameters.required_status_checks,
    protection.required_status_checks.checks.map((c) => ({
      context: c.context,
      integration_id: c.app_id,
    }))
  );
  assert.equal(rule('pull_request').parameters.required_approving_review_count, 0);
  assert.ok(rule('required_linear_history'));
  assert.equal(protection.enforce_admins, true);
  // Independent agents share the owner's GitHub identity. Keep the PR requirement;
  // freshness and exact-SHA approval are checked by the separate merger session.
  assert.ok(protection.required_pull_request_reviews);
  assert.equal(protection.required_pull_request_reviews.required_approving_review_count, 0);
  assert.equal(protection.required_pull_request_reviews.require_last_push_approval, false);
  assert.deepEqual(protection.required_pull_request_reviews.bypass_pull_request_allowances, {
    users: [],
    teams: [],
    apps: [],
  });
});
test('gate CLI retains full reports and fails for absent downloads instead of passing an empty set', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mycel-quality-gate-'));
  try {
    const input = gateFixture();
    const root = join(dir, 'shards');
    for (const a of input.run.artifacts) {
      mkdirSync(join(root, a.name), { recursive: true });
      writeFileSync(join(root, a.name, 'summary.json'), JSON.stringify(a.report));
    }
    const env = {
      ...process.env,
      GITHUB_RUN_ID: String(input.run.id),
      GITHUB_RUN_ATTEMPT: String(input.run.attempt),
      GITHUB_SHA: input.run.measuredSha,
      GITHUB_EVENT_NAME: input.run.event,
      QUALITY_NEEDS: JSON.stringify(input.needs),
      QUALITY_DOWNLOAD_OUTCOME: 'success',
    };
    const command = (path, out) =>
      execFileSync(process.execPath, ['scripts/quality/gate.mjs', path, out], {
        env,
        stdio: 'pipe',
      });
    command(root, join(dir, 'good'));
    const result = JSON.parse(readFileSync(join(dir, 'good', 'summary.json')));
    assert.equal(result.measured, 'pass');
    assert.equal(result.report.samples, 30);
    assert.equal(result.report.cells[0].batches[0].sampleIds.length, 5);
    assert.throws(() => command(join(dir, 'absent'), join(dir, 'bad')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'bad', 'summary.json'))).blocks, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('information expands both profiles/locales while historical v3 keeps its own coverage', () => {
  assert.equal(contract.fixtureVersion, '43a-v4');
  for (const locale of ['nl', 'en'])
    for (const profile of ['mobile', 'desktop']) {
      const shard = expectedShards(contract, 'local', {
        scope: 'default',
        locale,
        profile,
        cache: 'fresh',
      })[0];
      assert.ok(shard.ids.includes(`information-${locale}-${profile}-fresh`));
    }
  const old = JSON.parse(source('apps/web/e2e/quality-corpus.json'));
  old.fixtureVersion = '43a-v3';
  delete old.public.information;
  const historical = sourceContract({
    corpus: JSON.stringify(old),
    seed: 'historical seed',
    matrixSource: source('scripts/quality/matrix.mjs'),
    workflow: source('.github/workflows/frontend-quality.yml'),
    lock: source('package-lock.json'),
  });
  assert.equal(expectedShards(historical, 'workflow_dispatch').flatMap((s) => s.ids).length, 36);
  assert.equal(expectedShards(contract, 'workflow_dispatch').flatMap((s) => s.ids).length, 48);
  assert.notEqual(historical.fixtureHash, contract.fixtureHash);
  const run = retained('pull_request');
  for (const a of run.artifacts)
    a.report.cells = a.report.cells.filter((cell) => !cell.id.startsWith('information-'));
  assert.equal(consumeRun(run, load).state, 'not-measured');
});
