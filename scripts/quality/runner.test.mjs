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

// The consumer grows this existing suite: score fixtures remain the evaluator's contract;
// these cases cover the history/provenance boundary that a green observation job cannot prove.
import {
  consume,
  consumeRun,
  sourceContract,
  expectedShards,
  scheduleStatus,
  markdown,
} from './consume.mjs';
import { collectHistory } from './history.mjs';
const clock = '2026-10-27T12:00:00Z';
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const contract = sourceContract({
  corpus: source('apps/web/e2e/quality-corpus.json'),
  seed: source('scripts/e2e.mjs'),
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
            owner: 'dev',
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
  assert.equal(result.expected, 36);
  assert.equal(result.samples, 185);
  assert.equal(result.state, 'fail');
  assert.equal(result.conclusion, 'success');
  assert.equal(result.cells[0].batches.length, 2);
  assert.equal(result.proposals[0].address, '#43C-report');
  assert.deepEqual(result.proposals[0].aliases, ['#43B']);
  assert.equal(result.coverage[0].sourceAddress, '#43B');
  assert.equal(result.coverage[0].address, '#43C-preview');
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
test('weekly due/overdue clock never borrows manual or main measurements', () => {
  const workflow = { activatedAt: '2026-10-26T17:30:57Z', state: 'active', cron: '17 5 * * 1' };
  const runs = [{ event: 'workflow_dispatch', createdAt: '2026-11-02T05:18:00Z', state: 'pass' }];
  assert.equal(scheduleStatus(workflow, runs, clock).state, 'pending');
  assert.equal(scheduleStatus(workflow, runs, '2026-11-03T05:16:59Z').state, 'pending');
  assert.equal(scheduleStatus(workflow, runs, '2026-11-03T05:17:00Z').state, 'not-measured');
  runs.push({ id: 3, event: 'schedule', createdAt: '2026-11-02T05:19:00Z', state: 'fail' });
  assert.equal(scheduleStatus(workflow, runs, '2026-11-03T06:00:00Z').state, 'fail');
  assert.equal(scheduleStatus(workflow, runs, clock).state, 'pending');
  const late = scheduleStatus(
    workflow,
    [{ id: 4, event: 'schedule', createdAt: '2026-11-03T07:00:00Z', state: 'pass' }],
    '2026-11-03T07:01:00Z'
  );
  assert.equal(late.state, 'pass');
  assert.equal(late.windows[0].late, true);
  assert.equal(
    scheduleStatus({ ...workflow, state: 'disabled_manually' }, [], clock).state,
    'not-measured'
  );
  assert.equal(scheduleStatus({ ...workflow, state: 'unknown' }, [], clock).state, 'not-measured');
});
test('consumer retains attempts and separates head/merge/local provenance; unknown API/watchdog is not healthy', () => {
  const first = retained('pull_request');
  first.measuredSha = 'b'.repeat(40);
  first.mergeParents = [first.headSha];
  for (const a of first.artifacts) a.report.commit = first.measuredSha;
  const second = structuredClone(first);
  second.attempt = 2;
  const history = {
    schemaVersion: 1,
    workflow: { state: 'active', cron: '17 5 * * 1', activatedAt: '2026-10-26T17:30:57Z' },
    runs: [first, second],
    errors: ['unavailable'],
  };
  const result = consume(history, load, clock);
  assert.equal(result.runs.length, 2);
  assert.equal(result.runs[0].evidenceKind, 'pr-merge');
  assert.notEqual(result.runs[0].headSha, result.runs[0].measuredSha);
  assert.equal(result.state, 'not-measured');
  assert.match(markdown(result), /not-measured/);
  assert.throws(() => consume({ ...history, runs: [first, first] }, load, clock), /Duplicate/);
  history.errors = [];
  history.watchdog = {
    state: 'active',
    lastCompletedAt: '2026-10-24T00:00:00Z',
    conclusion: 'success',
  };
  assert.equal(consume(history, load, clock).state, 'not-measured');
  history.watchdog.lastCompletedAt = clock;
  assert.equal(consume(history, load, clock).state, 'pending');
  history.watchdog.lastScheduledAt = '2026-10-24T00:00:00Z';
  assert.equal(consume(history, load, clock).state, 'not-measured');
});
test('artifact adapter records API outage and independent watchdog has only read permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-history-'));
  try {
    const h = collectHistory({
      repo: 'owner/repo',
      out: join(dir, 'history'),
      api: () => {
        throw new Error('PRIVATE token');
      },
      download: () => {
        throw new Error('unused');
      },
    });
    assert.equal(h.errors.length, 2);
    assert.equal(consume(h, load, clock).state, 'not-measured');
    assert.doesNotMatch(readFileSync(join(dir, 'history/history.json'), 'utf8'), /PRIVATE/);
    const workflow = source('.github/workflows/frontend-quality-watchdog.yml');
    assert.match(workflow, /cron: '31 6 \* \* \*'/);
    assert.match(workflow, /actions: read/);
    assert.match(workflow, /contents: read/);
    assert.doesNotMatch(workflow, /: write|workflow_run:|issues:|pull-requests:/);
    assert.match(workflow, /retention-days: 90/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an inconclusive scheduled batch stays inconclusive, and cancelled attempts cannot pass', () => {
  const workflow = { activatedAt: '2026-10-26T17:30:57Z', state: 'active', cron: '17 5 * * 1' };
  const result = scheduleStatus(
    workflow,
    [{ id: 3, event: 'schedule', createdAt: '2026-11-02T05:19:00Z', state: 'inconclusive' }],
    '2026-11-03T06:00:00Z'
  );
  assert.equal(result.state, 'inconclusive');
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

test('GitHub adapter separates rerun artifacts by attempt and preserves corrupt originals as missing evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-attempts-'));
  const original = retained('push');
  const run = {
    id: 123,
    path: '.github/workflows/frontend-quality.yml',
    run_attempt: 2,
    created_at: '2026-10-26T18:00:00Z',
    event: 'pull_request',
    head_sha: original.headSha,
    html_url: original.url,
    status: 'completed',
    conclusion: 'success',
  };
  const files = {
    'apps/web/e2e/quality-corpus.json': source('apps/web/e2e/quality-corpus.json'),
    'scripts/e2e.mjs': source('scripts/e2e.mjs'),
    'scripts/quality/matrix.mjs': source('scripts/quality/matrix.mjs'),
    '.github/workflows/frontend-quality.yml': source('.github/workflows/frontend-quality.yml'),
    'package-lock.json': source('package-lock.json'),
  };
  const artifacts = [1, 2].flatMap((attempt) =>
    original.artifacts.map((a) => ({
      id: a.id + attempt * 10,
      name: a.name,
      created_at: `2026-10-26T${attempt === 1 ? '18' : '19'}:05:00Z`,
    }))
  );
  const api = (path) => {
    if (path.includes('/contents/'))
      return {
        content: Buffer.from(files[path.split('/contents/')[1].split('?')[0]]).toString('base64'),
      };
    if (path.includes('/pulls?'))
      return [
        { number: 90, head: { sha: original.headSha } },
        { number: 91, head: { sha: 'b'.repeat(40) } },
      ];
    if (path.includes('/commits/')) return { parents: [] };
    if (path.includes('/artifacts?')) return { artifacts };
    if (path.includes('/jobs?'))
      return {
        jobs: [
          {
            status: 'completed',
            started_at: '2026-10-26T18:00:00Z',
            completed_at: '2026-10-26T18:02:30Z',
          },
          {
            status: 'completed',
            started_at: '2026-10-26T18:00:00Z',
            completed_at: '2026-10-26T18:01:00Z',
          },
        ],
      };
    if (path.includes('/attempts/')) {
      const attempt = Number(path.split('/').at(-1));
      return { ...run, run_started_at: `2026-10-26T${attempt === 1 ? '18' : '19'}:00:00Z` };
    }
    if (path.includes('frontend-quality-watchdog.yml/runs')) return { workflow_runs: [] };
    if (path.includes('/runs?')) return { workflow_runs: [run] };
    if (path.includes('/workflows/')) return { state: 'active' };
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  try {
    const h = collectHistory({
      repo: 'owner/repo',
      out: join(dir, 'history'),
      api,
      download: (id) =>
        id === 21
          ? '{corrupt'
          : JSON.stringify(original.artifacts.find((a) => a.id === id % 10).report),
    });
    const report = consume(h, (a) => JSON.parse(readFileSync(join(dir, 'history', a.path))), clock);
    assert.deepEqual(
      report.runs.map((r) => r.attempt),
      [1, 2]
    );
    assert.equal(report.runs[0].state, 'pass');
    assert.equal(report.runs[0].runnerMinutes, 3.5);
    assert.deepEqual(report.runs[0].pullRequests, [90]);
    assert.equal(report.runs[0].createdAt, report.runs[1].createdAt);
    assert.notEqual(report.runs[0].startedAt, report.runs[1].startedAt);
    assert.equal(report.runs[1].state, 'not-measured');
    assert.equal(report.runs[1].present, 2);
    assert.ok(report.runs[1].issues.length);
    artifacts.length = 0;
    const missing = collectHistory({
      repo: 'owner/repo',
      out: join(dir, 'missing'),
      api,
      download: () => {
        throw new Error('no artifacts');
      },
    });
    const absent = consume(missing, load, clock);
    assert.equal(absent.runs[0].expected, 4);
    assert.equal(absent.runs[0].present, 0);
    assert.equal(absent.runs[0].missingShards.length, 2);
    assert.equal(absent.runs[0].expectationSha, original.headSha);
    assert.notEqual(absent.runs[0].state, 'pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a non-pass shard summary cannot be upgraded by its passing available cells', () => {
  for (const state of ['fail', 'inconclusive', 'not-measured']) {
    const run = retained();
    run.artifacts[0].report.state = state;
    assert.equal(consumeRun(run, load).state, state);
  }
});

test('historically routed product causes retain their address, owner and security tier', () => {
  const run = retained();
  const report = run.artifacts[0].report;
  const cell = report.cells[0];
  cell.state = cell.batches[0].state = 'fail';
  cell.batches[0].reasons = ['accessibility'];
  cell.batches[0].raw[0].accessibility = 0.98;
  report.repairs = [
    { key: 'accessibility:', address: '#39', owner: 'mbp', tier: 'flagship-review' },
  ];
  const result = consumeRun(run, load);
  assert.equal(result.proposals[0].sourceAddress, '#39');
  assert.equal(result.proposals[0].address, '#39');
  assert.equal(result.proposals[0].owner, 'mbp');
  assert.equal(result.proposals[0].tier, 'flagship-review');
});

test('aggregate routing preserves established claims and highest tier in both run orders', () => {
  const makeRun = (id, routing) => {
    const run = retained();
    run.id = id;
    run.attempt = id === 102 ? 2 : 1;
    const report = run.artifacts[0].report;
    const cell = report.cells[0];
    cell.state = cell.batches[0].state = 'fail';
    cell.batches[0].reasons = ['accessibility'];
    cell.batches[0].raw[0].accessibility = 0.98;
    if (routing) report.repairs = [{ key: 'accessibility:', ...routing }];
    return run;
  };
  const generic = makeRun(100);
  const product = makeRun(101, { address: '#39', owner: 'mbp', tier: 'flagship-review' });
  const conflict = makeRun(102, { address: '#40', owner: 'dev', tier: 'flagship-only' });
  const history = { schemaVersion: 1, runs: [], workflow: {} };
  for (const runs of [
    [generic, product],
    [product, generic],
  ]) {
    const result = consume({ ...history, runs }, load, clock);
    const proposal = result.proposals[0];
    assert.equal(proposal.address, '#39');
    assert.equal(proposal.owner, 'mbp');
    assert.equal(proposal.tier, 'flagship-review');
    assert.equal(proposal.routingState, 'resolved');
    assert.equal(proposal.routingClaims.length, 2);
    assert.deepEqual(new Set(proposal.sourceAddresses), new Set(['#43C', '#39']));
    assert.deepEqual(
      proposal.runs,
      result.runs.map((r) => ({
        id: r.id,
        attempt: r.attempt,
        artifact: r.proposals[0].artifact,
        cells: r.proposals[0].cells,
      }))
    );
    assert.deepEqual(proposal.routingClaims.map((c) => c.runs).flat(), proposal.runs);
  }
  const sameAddress = makeRun(103, { address: '#39', owner: 'mbp', tier: 'flagship-only' });
  const ownerConflict = makeRun(104, { address: '#39', owner: 'dev', tier: 'workhorse' });
  for (const runs of [
    [product, sameAddress],
    [sameAddress, product],
  ]) {
    const proposal = consume({ ...history, runs }, load, clock).proposals[0];
    assert.equal(proposal.address, '#39');
    assert.equal(proposal.routingState, 'resolved');
    assert.equal(proposal.tier, 'flagship-only');
  }
  for (const runs of [
    [product, ownerConflict],
    [ownerConflict, product],
  ]) {
    const proposal = consume({ ...history, runs }, load, clock).proposals[0];
    assert.equal(proposal.routingState, 'conflict');
    assert.equal(proposal.owner, null);
    assert.equal(proposal.tier, 'flagship-review');
  }
  for (const runs of [
    [generic, product, conflict],
    [conflict, product, generic],
  ]) {
    const result = consume({ ...history, runs }, load, clock);
    const proposal = result.proposals[0];
    assert.equal(proposal.routingState, 'conflict');
    assert.equal(proposal.address, null);
    assert.equal(proposal.owner, null);
    assert.equal(proposal.tier, 'flagship-only');
    assert.equal(proposal.routingClaims.length, 3);
    assert.deepEqual(
      new Set(proposal.routingClaims.map((c) => c.address)),
      new Set(['#43C', '#39', '#40'])
    );
    assert.equal(proposal.runs.find((r) => r.id === 102).attempt, 2);
    assert.match(markdown(result), /Routing conflict/);
  }
});

test('routing retains artifact-scoped claims and exact cells in both shard orders', () => {
  const product = { address: '#39', owner: 'mbp', tier: 'flagship-review' };
  for (const other of [
    { address: '#43C', owner: 'mbp', tier: 'workhorse' },
    { address: '#40', owner: 'dev', tier: 'flagship-only' },
    { address: '#39', owner: 'dev', tier: 'workhorse' },
    { address: '#39', owner: 'mbp', tier: 'flagship-only' },
  ]) {
    const run = retained();
    const sources = [product, other].map((routing, index) => {
      const artifact = run.artifacts[index];
      const report = artifact.report;
      const cell = report.cells[0];
      cell.state = cell.batches[0].state = report.state = 'fail';
      cell.batches[0].reasons = ['accessibility'];
      cell.batches[0].raw[0].accessibility = 0.98;
      report.repairs = [{ key: 'accessibility:', ...routing }];
      return { ...routing, artifact: artifact.name, cells: [cell.id] };
    });
    for (const artifacts of [run.artifacts, [...run.artifacts].reverse()]) {
      const result = consume(
        { schemaVersion: 1, workflow: {}, runs: [{ ...run, artifacts }] },
        load,
        clock
      );
      assert.deepEqual(result.runs[0].issues, []);
      const proposal = result.proposals[0];
      const conflict =
        other.address !== '#43C' && (other.address !== '#39' || other.owner !== 'mbp');
      assert.equal(proposal.address, conflict ? null : '#39');
      assert.equal(proposal.owner, conflict ? null : 'mbp');
      assert.equal(proposal.routingState, conflict ? 'conflict' : 'resolved');
      assert.equal(
        proposal.tier,
        other.tier === 'flagship-only' ? 'flagship-only' : 'flagship-review'
      );
      assert.equal(proposal.routingClaims.length, 2);
      for (const source of sources) {
        const claim = proposal.routingClaims.find(
          (c) => c.address === source.address && c.owner === source.owner && c.tier === source.tier
        );
        assert.deepEqual(claim.runs, [
          { id: run.id, attempt: run.attempt, artifact: source.artifact, cells: source.cells },
        ]);
      }
      assert.equal(proposal.runs.length, 2);
      assert.match(markdown(result), new RegExp(sources[0].artifact));
    }
  }
});

import { factory, factoryMarkdown, closureInput, environmentKey } from './factory.mjs';
const humanInput = () => ({
  schemaVersion: 1,
  closures: [],
  exceptions: [],
  falseAlarms: [],
  implementedRoutes: [],
});
function processRun({
  id = 123,
  head = 'a',
  pr = 90,
  attempt = 1,
  state = 'pass',
  at = '2026-10-26T18:00:00Z',
} = {}) {
  const run = retained('pull_request');
  Object.assign(run, {
    id,
    attempt,
    headSha: head.repeat(40),
    measuredSha: head.repeat(40),
    pullRequests: [pr],
    startedAt: at,
    createdAt: at,
  });
  for (const a of run.artifacts) {
    a.report.commit = run.measuredSha;
    a.report.state = state;
    for (const c of a.report.cells) {
      c.state = c.batches[0].state = state;
      if (state === 'fail') {
        c.batches[0].reasons = ['page-identity:wrong-item'];
        c.batches[0].identityIssues = ['wrong-item'];
      }
    }
  }
  return consumeRun(run, load);
}
const processReport = (runs) => ({
  schemaVersion: 1,
  asOf: clock,
  state: 'not-measured',
  schedule: { state: 'pending', windows: [] },
  runs,
});
test('factory keeps first-pass denominator per PR head, not routes/reruns or job colour', () => {
  const red = processRun({ state: 'fail' });
  const green = processRun({ attempt: 2, at: '2026-10-26T19:00:00Z' });
  const diagnostic = structuredClone(red.cells[0].batches[0]);
  diagnostic.state = 'pass';
  red.cells[0].batches.push(diagnostic);
  const missing = processRun({ id: 124, head: 'b', pr: 91 });
  missing.present = 0;
  const later = processRun({ id: 124, attempt: 2, head: 'b', pr: 91, at: '2026-10-26T20:00:00Z' });
  const unknown = processRun({ id: 125, head: 'c', pr: 92, state: 'inconclusive' });
  const passing = processRun({ id: 126, head: 'd', pr: 93 });
  const r = factory(processReport([green, unknown, red, missing, later, passing]));
  assert.equal(r.firstPass.numerator, 1);
  assert.equal(r.firstPass.denominator, 2);
  assert.equal(r.firstPass.noValidHeads, 2);
  assert.equal(r.firstPass.missingAttempts, 1);
  assert.equal(r.firstPass.inconclusiveAttempts, 1);
  assert.equal(r.firstPass.heads.find((h) => h.headSha === red.headSha).firstValid.state, 'fail');
  assert.equal(r.baseline.firstTen.progress, 4);
  assert.equal(r.cost.reruns, 2);
  assert.equal(r.cost.diagnosticBatches, 1);
  assert.equal(r.cost.knownRunnerMinutes, 'not-measured');
  assert.equal(r.effort.activeRepairMinutes, 'not-measured');
  assert.equal(r.closureInput, 'not-measured');
  assert.equal(r.defects.escapes, 'not-measured');
  assert.equal(r.cost.falseAlarms, 'not-measured');
  assert.equal(r.weekly.firstPass.denominator, 2);
  assert.equal(r.weekly.attempts, 6);
  assert.doesNotMatch(factoryMarkdown(r), /PRIVATE|secret@/);
});
test('factory cohorts count ten distinct PRs, retain heads and never invent an improvement', () => {
  const runs = Array.from({ length: 20 }, (_, i) =>
    processRun({ id: i + 1, head: (i + 1).toString(16).padStart(40, '0').slice(0, 1) })
  );
  // Use distinct real-length hex heads; multiple heads of one PR still count one PR.
  runs.forEach((r, i) => {
    r.headSha = (i + 1).toString(16).padStart(40, '0');
    r.pullRequests = [i + 1];
  });
  runs.push({ ...runs[0], id: 30, headSha: 'f'.repeat(40) });
  const partial = factory(processReport(runs.slice(0, 9)));
  assert.equal(partial.baseline.firstTen.progress, 9);
  assert.equal(partial.baseline.comparison, 'pending-next-ten');
  const full = factory(processReport(runs));
  assert.equal(full.baseline.firstTen.progress, 10);
  assert.equal(full.baseline.nextTen.progress, 10);
  assert.equal(full.baseline.firstTen.denominator, 11);
  assert.equal(full.baseline.comparison, 'ready-for-human-bottleneck-analysis');
  assert.equal(full.baseline.improvement, 'not-measured');
  runs.push({ ...runs[0], id: 31, headSha: 'e'.repeat(40), pullRequests: [] });
  assert.equal(factory(processReport(runs)).baseline.comparison, 'pending-next-ten');
});
test('factory deduplicates recurrence by cause after closure, checks environment and expires exceptions', () => {
  const red = processRun({ state: 'fail' });
  const again = processRun({ id: 124, head: 'b', state: 'fail', at: '2026-10-27T10:00:00Z' });
  const otherEnvironment = processRun({
    id: 125,
    head: 'c',
    state: 'fail',
    at: '2026-10-27T11:00:00Z',
  });
  otherEnvironment.tools.chromium = 'other';
  const input = humanInput();
  const key = red.proposals[0].key;
  input.closures.push({
    key,
    address: '#11-writer-targets',
    owner: 'mbp',
    defectSha: red.measuredSha,
    repairedSha: 'd'.repeat(40),
    environment: environmentKey(red),
    detectedAt: red.startedAt,
    repairedAt: '2026-10-27T09:00:00Z',
    detectedAfterMerge: true,
    activeRepairMinutes: null,
    prevention: {
      kind: 'gate',
      gate: 'identity-suite',
      red: 'https://github.com/bolsterdigital/mycel/actions/runs/123',
      green: 'https://github.com/bolsterdigital/mycel/actions/runs/124',
      missedGate: 'wrong-item',
      durableRule: 'identity-target',
    },
  });
  input.exceptions.push({
    id: 'exception-1',
    cell: 'article-nl-mobile-fresh',
    criterion: 'seo',
    owner: 'mbp',
    address: '#11',
    expiresAt: '2026-10-27T00:00:00Z',
    decision: 'https://github.com/bolsterdigital/mycel/pull/90',
  });
  input.falseAlarms.push({
    runId: 125,
    attempt: 1,
    evidence: 'https://github.com/bolsterdigital/mycel/pull/90',
  });
  const r = factory(processReport([red, again, otherEnvironment]), input);
  assert.equal(r.closures[0].sourceVerified, true);
  assert.equal(r.closures[0].calendarMinutes, 900);
  assert.equal(r.closures[0].activeRepairMinutes, 'not-measured');
  assert.equal(r.causes.length, 1);
  assert.equal(r.causes[0].escapes, 1);
  assert.equal(r.causes[0].recurrence.length, 1);
  assert.equal(r.causes[0].address, '#11-writer-targets');
  assert.equal(r.prevention.numerator, 1);
  assert.equal(r.coverageDebt.expiredExceptions.length, 1);
  assert.equal(r.cost.falseAlarms.length, 1);
  const duplicate = structuredClone(input);
  duplicate.closures.push(structuredClone(duplicate.closures[0]));
  assert.throws(() => closureInput(duplicate));
  input.closures[0].prevention = null;
  assert.equal(factory(processReport([red]), input).prevention.numerator, 0);
  input.closures[0].environment = '0'.repeat(64);
  assert.equal(factory(processReport([red]), input).closures[0].sourceVerified, false);
});
test('factory rejects private notes, arbitrary evidence URLs, duplicate closures and invalid clocks', () => {
  const input = humanInput();
  assert.throws(() => closureInput({ ...input, notes: 'PRIVATE person@example.org' }));
  input.implementedRoutes.push({
    route: 'preview',
    owner: 'mbp',
    address: '#43C-preview',
    source: 'https://private.invalid/notes',
  });
  assert.throws(() => closureInput(input));
  assert.throws(() => factory({ schemaVersion: 1, asOf: 'yesterday', runs: [] }));
  const r = processRun();
  r.runnerMinutes = 3.5;
  const future = { ...r, id: 200, startedAt: '2027-01-01T00:00:00Z', runnerMinutes: 100 };
  assert.equal(factory(processReport([r, future])).cost.knownRunnerMinutes, 3.5);
});

// The required check consumes real report fixtures, not a matrix job's success colour.
import { gate, enforcement } from './gate.mjs';
const policy = JSON.parse(source('scripts/quality/enforcement.json'));
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
test('container shards bind the immutable userspace and kernel while retaining host images', () => {
  const input = gateFixture();
  const digest = 'd65108d1a8095d8b0c4a5e32bf1807a40a5ce90ff0c78473e1116b1c243235e8';
  input.run.contract = { ...input.run.contract, runnerImage: `sha256:${digest}` };
  for (const [n, artifact] of input.run.artifacts.entries()) {
    Object.assign(artifact.report.environment, {
      runner: `github-container:sha256:${digest}`,
      hostImage: ['20261026.354.1', '20261023.334.3'][n],
      kernel: '6.11.0-1018-azure',
    });
  }
  const result = gate(input);
  assert.equal(result.blocks, false);
  assert.equal(result.report.present, 4);
  assert.equal(result.report.samples, 20);
  assert.deepEqual(
    result.report.profiles.map((p) => p.environment.hostImage),
    ['20261026.354.1', '20261023.334.3']
  );
  assert.notEqual(
    environmentKey(result.report),
    environmentKey({ ...result.report, tools: { ...result.report.tools, kernel: 'other' } })
  );
  for (const field of [
    'runner',
    'kernel',
    'node',
    'lighthouse',
    'playwright',
    'chromium',
    'caddy',
  ]) {
    const bad = { ...input, run: structuredClone(input.run) };
    bad.run.artifacts[1].report.environment[field] += '-changed';
    assert.equal(gate(bad).blocks, true, field);
  }
  for (const field of ['runner', 'kernel', 'hostImage']) {
    const bad = { ...input, run: structuredClone(input.run) };
    delete bad.run.artifacts[1].report.environment[field];
    assert.equal(gate(bad).blocks, true, `missing ${field}`);
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
    seed: source('scripts/e2e.mjs'),
    matrixSource: source('scripts/quality/matrix.mjs'),
    workflow,
    lock: source('package-lock.json'),
  };
  assert.throws(() =>
    sourceContract({ ...inputs, workflow: workflow.replace(/@sha256:[a-f0-9]{64}/, '') })
  );
});
test('required quality context validates complete default and full evidence at the UTC boundary', () => {
  for (const event of ['pull_request', 'push', 'schedule', 'workflow_dispatch']) {
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
  const early = {
    at: '2026-11-02T12:00:00Z',
    candidateSha: 'a'.repeat(40),
    fixtureHash: 'b'.repeat(64),
    runs: [1, 2].map((n) => `https://github.com/bolsterdigital/mycel/actions/runs/${n}`),
    review: 'https://github.com/bolsterdigital/mycel/pull/90#pullrequestreview-123',
  };
  const activated = { ...policy, earlyActivation: early };
  assert.equal(enforcement(activated, '2026-11-02T11:59:59.999Z'), false);
  assert.equal(enforcement(activated, early.at), true);
  const input = gateFixture();
  input.run.artifacts[0].report.state = 'fail';
  assert.equal(gate({ ...input, policy: activated, now: early.at }).blocks, true);
  assert.throws(() => enforcement({ ...activated, deadline: '2026-12-01' }, early.at));
  assert.throws(() => enforcement({ ...policy, earlyActivation: {} }, early.at));
  assert.throws(() =>
    enforcement(
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
    'observe',
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
  assert.equal(protection.required_status_checks.strict, true);
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
    assert.equal(result.report.samples, 20);
    assert.equal(result.report.cells[0].batches[0].sampleIds.length, 5);
    assert.throws(() => command(join(dir, 'absent'), join(dir, 'bad')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'bad', 'summary.json'))).blocks, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
