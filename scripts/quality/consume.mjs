// Read retained evidence without changing scores or private planning. A run is a boundary:
// mixing attempts, commits or profiles would hide the failures this consumer must preserve.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { matrix } from './matrix.mjs';
import { repairProposals } from './evaluate.mjs';

const states = ['pass', 'fail', 'inconclusive', 'not-measured'];
const token = (v) => typeof v === 'string' && /^[a-zA-Z0-9_.:#, /+-]{1,240}$/.test(v);
const sha = (v) => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const hash = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const iso = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const issue = (reason) => ({ reason, owner: 'dev', address: '#43C-report' });
const key = (s) => `${s.scope}-${s.locale}-${s.profile}-${s.cache}`;
const worst = (values) =>
  ['fail', 'not-measured', 'inconclusive'].find((state) => values.includes(state)) ??
  (values.length ? 'pass' : 'not-measured');

// Snapshot the data contract from measured source bytes, never import/execute artifact code.
// A new corpus/matrix protocol requires an explicit consumer adapter, not guessing coverage.
export function sourceContract({ corpus, seed, matrixSource, workflow, lock }) {
  const manifest = JSON.parse(corpus);
  if (manifest.fixtureVersion !== '43a-v3' || manifest.schemaVersion !== 1)
    throw new Error('unsupported-corpus');
  if (matrixSource !== readFileSync(new URL('./matrix.mjs', import.meta.url), 'utf8'))
    throw new Error('unsupported-matrix');
  const packages = JSON.parse(lock).packages;
  const runnerImage = /QUALITY_RUNNER_IMAGE: \S+@((?:sha256:)[a-f0-9]{64})\s/.exec(workflow)?.[1];
  if (workflow.includes('QUALITY_RUNNER_IMAGE:') && !runnerImage)
    throw new Error('unsupported-runner-image');
  return {
    schemaVersion: 1,
    fixtureVersion: manifest.fixtureVersion,
    fixtureHash: createHash('sha256').update(corpus).update(seed).digest('hex'),
    manifest,
    ...(runnerImage ? { runnerImage } : {}),
    tools: {
      node: `v${/node-version: '([^']+)'/.exec(workflow)?.[1]}`,
      lighthouse: packages['node_modules/lighthouse'].version,
      playwright: packages['node_modules/@playwright/test'].version,
      caddy: /caddy\/releases\/download\/v([\d.]+)/.exec(workflow)?.[1],
    },
  };
}
export function expectedShards(contract, event, selection) {
  if (
    contract.schemaVersion !== 1 ||
    contract.fixtureVersion !== '43a-v3' ||
    !hash(contract.fixtureHash)
  )
    throw new Error('invalid-contract');
  const shards = event === 'local' ? [selection] : matrix(event).include;
  return shards.map((s) => {
    if (
      !matrix('schedule').include.some(
        (candidate) =>
          key(candidate) === key({ ...s, scope: s.scope === 'full' ? 'default' : s.scope })
      )
    )
      throw new Error('invalid-profile');
    const names =
      s.scope === 'admin'
        ? contract.manifest.admin.routes.map((entry) => entry.name)
        : [
            ...Object.keys(contract.manifest.public),
            ...(s.scope === 'full'
              ? contract.manifest.admin.routes.map((entry) => entry.name)
              : []),
          ];
    return {
      ...s,
      name: `quality-summary-${key(s)}`,
      ids: names.map((name) => `${name}-${s.locale}-${s.profile}-${s.cache}`),
    };
  });
}

export function currentAddress(address, preview = false) {
  return address === '#43B' ? (preview ? '#43C-preview' : '#43C-report') : address;
}
function coverageView(entries) {
  return entries.map((entry) => ({
    route: token(entry.route) ? entry.route : 'unclassified',
    state:
      entry.route === 'dynamic POST/iframe preview'
        ? 'not-measured'
        : states.includes(entry.state)
          ? entry.state
          : 'not-measured',
    representation: entry.route === 'demanding tenant theme' ? 'simulated' : null,
    owner: entry.owner === 'dev' ? 'dev' : 'mbp',
    sourceAddress: token(entry.address) ? entry.address : null,
    address:
      currentAddress(entry.address, entry.route === 'dynamic POST/iframe preview') ??
      entry.dependency ??
      '#43C-report',
    dependency: token(entry.dependency) ? entry.dependency : null,
    // Coverage remains explicit; arbitrary free text and report errors are never published.
  }));
}
function safeBatch(batch) {
  if (
    !states.includes(batch.state) ||
    !Array.isArray(batch.sampleIds) ||
    batch.sampleIds.length !== 5 ||
    new Set(batch.sampleIds).size !== 5 ||
    !batch.sampleIds.every(token) ||
    !Array.isArray(batch.raw) ||
    batch.raw.length !== 5 ||
    !Array.isArray(batch.reasons) ||
    !batch.reasons.every(token) ||
    !Array.isArray(batch.failedAuditIds) ||
    !batch.failedAuditIds.every(token)
  )
    throw new Error('invalid-batch');
  if (
    ['median', 'min', 'max'].some(
      (key) => batch.performance?.[key] !== null && !Number.isFinite(batch.performance?.[key])
    )
  )
    throw new Error('invalid-performance');
  const raw = batch.raw.map((scores) =>
    Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map((c) => {
        const n = scores[c];
        if (n !== null && (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1))
          throw new Error('invalid-score');
        return [c, n];
      })
    )
  );
  return {
    state: batch.state,
    sampleIds: batch.sampleIds,
    raw,
    reasons: batch.reasons,
    failedAuditIds: batch.failedAuditIds,
    failedAuditIdsByCategory: Object.fromEntries(
      ['performance', 'accessibility', 'best-practices', 'seo'].map((c) => [
        c,
        (batch.failedAuditIdsByCategory?.[c] ?? []).filter(token),
      ])
    ),
    identityIssues: (batch.identityIssues ?? []).filter(token),
    metrics: (batch.metrics ?? []).map((metrics) =>
      Object.fromEntries(
        Object.entries(metrics).filter(
          ([k, v]) => token(k) && (v === null || (typeof v === 'number' && Number.isFinite(v)))
        )
      )
    ),
    performance: {
      median: batch.performance?.median ?? null,
      min: batch.performance?.min ?? null,
      max: batch.performance?.max ?? null,
    },
  };
}

export function consumeRun(run, load) {
  const issues = [];
  const cells = [];
  const coverage = [];
  const artifacts = [];
  const proposals = [];
  const reportStates = [];
  let expected = [];
  let referenceTools;
  const profiles = [];
  try {
    expected = expectedShards(run.contract, run.event, run.selection);
  } catch {
    issues.push(issue('invalid-or-unsupported-contract'));
  }
  if (
    !sha(run.headSha) ||
    !sha(run.measuredSha) ||
    !['local', 'push', 'pull_request', 'schedule', 'workflow_dispatch'].includes(run.event)
  )
    issues.push(issue('invalid-run-provenance'));
  if (
    run.measuredSha !== run.headSha &&
    !(run.event === 'pull_request' && run.mergeParents?.includes(run.headSha))
  )
    issues.push(issue('unrelated-measured-sha'));
  if (run.error) issues.push(issue('run-or-source-unavailable'));
  if (run.status !== 'completed') issues.push(issue('run-incomplete'));
  if (run.conclusion !== 'success') issues.push(issue('run-unsuccessful'));
  const names = new Set();
  const ids = new Set();
  for (const artifact of run.artifacts ?? []) {
    const name = token(artifact.name) ? artifact.name : 'invalid-name';
    const link = Number.isSafeInteger(artifact.id)
      ? `${run.url?.replace(/\/attempts\/\d+$/, '')}/artifacts/${artifact.id}`
      : null;
    artifacts.push({ name, url: link, available: !artifact.error });
    if (names.has(name)) {
      issues.push(issue('duplicate-artifact'));
      continue;
    }
    names.add(name);
    const shard = expected.find((s) => s.name === name);
    if (!shard) {
      issues.push(issue('unexpected-shard'));
      continue;
    }
    try {
      if (artifact.error) throw new Error('unavailable');
      const report = load(artifact);
      const env = report.environment;
      if (
        report.schemaVersion !== 1 ||
        report.commit !== run.measuredSha ||
        report.fixtureHash !== run.contract.fixtureHash ||
        report.fixtureVersion !== run.contract.fixtureVersion
      )
        throw new Error('provenance');
      if (
        !env ||
        ['scope', 'locale', 'profile', 'cache'].some((f) => env[f] !== shard[f]) ||
        env.mode !== (run.event === 'local' ? 'local' : 'ci') ||
        !token(env.runner) ||
        !(run.event === 'local'
          ? env.runner.startsWith('local:')
          : run.contract.runnerImage
            ? env.runner === `github-container:${run.contract.runnerImage}` &&
              token(env.kernel) &&
              token(env.hostImage)
            : env.runner.startsWith('github-ubuntu-24.04:'))
      )
        throw new Error('profile');
      const tools = Object.fromEntries(
        ['node', 'lighthouse', 'playwright', 'chromium', 'caddy', 'runner'].map((f) => [f, env[f]])
      );
      if (run.event !== 'local' && run.contract.runnerImage) tools.kernel = env.kernel;
      if (Object.values(tools).some((v) => typeof v !== 'string' || v.length > 200))
        throw new Error('tools');
      if (
        run.event !== 'local' &&
        (['node', 'lighthouse', 'playwright'].some((f) => tools[f] !== run.contract.tools[f]) ||
          !tools.caddy.startsWith(`v${run.contract.tools.caddy} `))
      )
        throw new Error('tools');
      // Container userspace and the shared host kernel must agree. Retain the rolling host
      // image as metadata; it no longer supplies browser libraries/fonts. Legacy host runs
      // still compare that image strictly through their original runner identity.
      if (referenceTools && JSON.stringify(referenceTools) !== JSON.stringify(tools))
        throw new Error('tool-drift');
      referenceTools ??= tools;
      profiles.push({
        artifact: name,
        environment: {
          ...tools,
          ...Object.fromEntries(
            [
              'scope',
              'locale',
              'profile',
              'cache',
              'theme',
              'warmup',
              'serverCache',
              'cpu',
              'hostImage',
            ]
              .filter((f) => token(env[f]))
              .map((f) => [f, env[f]])
          ),
          cores: Number.isInteger(env.cores) ? env.cores : null,
        },
      });
      if (!Array.isArray(report.cells) || !states.includes(report.state)) throw new Error('shape');
      reportStates.push(report.state);
      artifacts.at(-1).state = report.state;
      if (report.error || report.interrupted || report.activeCell)
        issues.push(issue('report-interrupted'));
      const artifactCells = [];
      for (const cell of report.cells) {
        if (ids.has(cell.id)) {
          issues.push(issue('duplicate-cell'));
          continue;
        }
        ids.add(cell.id);
        if (
          !shard.ids.includes(cell.id) ||
          cell.profile !== shard.profile ||
          cell.locale !== shard.locale ||
          cell.cache !== shard.cache ||
          !states.includes(cell.state) ||
          !Array.isArray(cell.batches) ||
          !cell.batches.length ||
          cell.batches.length > 2
        )
          throw new Error('cell');
        const publicEntry = Object.entries(run.contract.manifest.public).find(
          ([name]) => cell.id === `${name}-${shard.locale}-${shard.profile}-${shard.cache}`
        )?.[1];
        const adminEntry = run.contract.manifest.admin.routes.find(
          (entry) => cell.id === `${entry.name}-${shard.locale}-${shard.profile}-${shard.cache}`
        );
        const expectedPath = publicEntry?.locales[shard.locale].path ?? adminEntry?.path;
        const route = new URL(cell.route);
        const pathParts = expectedPath?.split('{quality-article-id}');
        if (
          route.origin !== 'https://localhost:4443' ||
          route.search ||
          route.hash ||
          !expectedPath ||
          (pathParts.length === 1
            ? route.pathname !== expectedPath
            : !route.pathname.startsWith(pathParts[0]) ||
              !route.pathname.endsWith(pathParts[1]) ||
              !/^[a-f0-9-]{36}$/.test(
                route.pathname.slice(
                  pathParts[0].length,
                  pathParts[1].length ? -pathParts[1].length : undefined
                )
              ))
        )
          throw new Error('route');
        const batches = cell.batches.map(safeBatch);
        if (
          cell.state !== worst(batches.map((b) => b.state)) &&
          !(
            cell.state === 'inconclusive' &&
            batches.some((b) => b.state === 'inconclusive') &&
            !batches.some((b) => b.state === 'fail')
          )
        )
          throw new Error('cell-state');
        // A forged green state cannot conceal red category scores or deterministic reasons.
        if (
          cell.state === 'pass' &&
          batches.some(
            (b) =>
              b.reasons.length ||
              b.raw.some((r) =>
                [
                  'accessibility',
                  'best-practices',
                  ...(Object.keys(run.contract.manifest.public).some(
                    (name) => cell.id === `${name}-${shard.locale}-${shard.profile}-${shard.cache}`
                  )
                    ? ['seo']
                    : []),
                ].some((c) => r[c] !== 1)
              ) ||
              b.raw.map((r) => r.performance).some((n) => n === null) ||
              [...b.raw.map((r) => r.performance)].sort((a, b) => a - b)[2] < 0.995 ||
              Math.min(...b.raw.map((r) => r.performance)) < 0.98
          )
        )
          throw new Error('false-pass');
        const retainedCell = {
          id: cell.id,
          route: cell.route,
          state: cell.state,
          profile: shard.profile,
          locale: shard.locale,
          cache: shard.cache,
          batches,
        };
        cells.push(retainedCell);
        artifactCells.push(retainedCell);
      }
      coverage.push(...coverageView(report.coverage ?? []));
      // Bind claims to their validated shard cells before any cause is deduplicated.
      // A run-wide map would let an unrelated later shard replace the source route.
      for (const p of repairProposals(artifactCells)) {
        const claims = (report.repairs ?? []).filter(
          (claim) => claim.key === p.key && token(claim.address)
        );
        for (const claim of claims.length ? claims : [p]) {
          const sourceAddress = claim.address;
          const address = currentAddress(sourceAddress);
          proposals.push({
            ...p,
            artifact: name,
            sourceAddress,
            address,
            ...(['dev', 'mbp'].includes(claim.owner) ? { owner: claim.owner } : {}),
            ...(['workhorse', 'flagship-review', 'flagship-only'].includes(claim.tier)
              ? { tier: claim.tier }
              : {}),
            ...(address === '#43C-report' ? { aliases: ['#43B'] } : {}),
          });
        }
      }
      if (report.state === 'pass' && report.cells.some((c) => c.state !== 'pass'))
        throw new Error('summary-state');
    } catch {
      issues.push(issue('corrupt-or-mismatched-report'));
    }
  }
  const missingShards = expected.filter((s) => !names.has(s.name)).map((s) => s.name);
  const missingCells = expected.flatMap((s) => s.ids).filter((id) => !ids.has(id));
  if (missingShards.length) issues.push(issue('missing-shard'));
  if (missingCells.length) issues.push(issue('missing-cell'));
  return {
    id: run.id,
    attempt: run.attempt,
    event: run.event,
    evidenceKind:
      run.event === 'pull_request' ? 'pr-merge' : run.event === 'push' ? 'main' : run.event,
    headSha: run.headSha,
    measuredSha: run.measuredSha,
    expectationSha: run.expectationSha ?? run.measuredSha,
    url: run.url,
    pullRequests: (run.pullRequests ?? []).filter((n) => Number.isSafeInteger(n) && n > 0),
    runnerMinutes:
      Number.isFinite(run.runnerMinutes) && run.runnerMinutes >= 0 ? run.runnerMinutes : null,
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? run.createdAt,
    status: run.status,
    conclusion: run.conclusion,
    fixtureVersion: run.contract?.fixtureVersion ?? null,
    fixtureHash: run.contract?.fixtureHash ?? null,
    tools: referenceTools ?? null,
    profiles,
    state:
      cells.some((c) => c.state === 'fail') || reportStates.includes('fail')
        ? 'fail'
        : issues.length
          ? 'not-measured'
          : worst([...cells.map((c) => c.state), ...reportStates]),
    expected: expected.reduce((n, s) => n + s.ids.length, 0),
    present: cells.length,
    samples: cells.reduce((n, c) => n + c.batches.reduce((m, b) => m + b.sampleIds.length, 0), 0),
    counts: Object.fromEntries(
      states.map((state) => [state, cells.filter((c) => c.state === state).length])
    ),
    missingShards,
    missingCells,
    issues,
    cells,
    artifacts,
    coverage: [...new Map(coverage.map((entry) => [JSON.stringify(entry), entry])).values()],
    proposals,
  };
}

export function scheduleStatus(workflow, runs, now) {
  const issues = [];
  if (!iso(now) || !iso(workflow?.activatedAt) || workflow.cron !== '17 5 * * 1')
    return { state: 'not-measured', issues: [issue('unknown-schedule-contract')] };
  if (workflow.state !== 'active')
    issues.push(
      issue(
        workflow.state === 'disabled_manually' || workflow.state === 'disabled_inactivity'
          ? 'workflow-disabled'
          : 'workflow-state-unknown'
      )
    );
  const start = new Date(workflow.activatedAt);
  const due = new Date(start);
  due.setUTCHours(5, 17, 0, 0);
  while (due <= start || due.getUTCDay() !== 1) due.setUTCDate(due.getUTCDate() + 1);
  const windows = [];
  const clock = Date.parse(now);
  while (due.getTime() <= clock || !windows.length) {
    const next = new Date(due.getTime() + 7 * 86400000);
    const overdueAt = new Date(due.getTime() + 86400000).toISOString();
    const actual = runs.filter(
      (r) =>
        r.event === 'schedule' &&
        Date.parse(r.createdAt) >= due.getTime() &&
        Date.parse(r.createdAt) < next.getTime() &&
        Date.parse(r.createdAt) <= clock
    );
    windows.push({
      dueAt: due.toISOString(),
      overdueAt,
      graceHours: 24,
      runIds: actual.map((r) => r.id),
      late: actual.some((r) => Date.parse(r.createdAt) >= Date.parse(overdueAt)),
      state: actual.length
        ? worst(actual.map((r) => r.state))
        : clock >= Date.parse(overdueAt)
          ? 'not-measured'
          : 'pending',
      owner: 'dev',
      address: '#43C-report',
    });
    if (next.getTime() > clock) break;
    due.setTime(next.getTime());
  }
  return {
    state:
      issues.length || windows.some((w) => w.state === 'not-measured')
        ? 'not-measured'
        : windows.some((w) => w.state === 'fail')
          ? 'fail'
          : windows.some((w) => w.state === 'inconclusive')
            ? 'inconclusive'
            : windows.some((w) => w.state === 'pending')
              ? 'pending'
              : 'pass',
    issues,
    windows,
  };
}

// Resolve routing from every source claim, not whichever API run arrives first. Conflicting
// established addresses/owners need human deduplication; a generic fallback cannot settle them.
function aggregateProposals(runs) {
  const all = new Map();
  const tiers = ['workhorse', 'flagship-review', 'flagship-only'];
  const generic = new Set(['#43B', '#43C', '#43C-report']);
  for (const run of runs) {
    for (const proposal of run.proposals) {
      const entry = all.get(proposal.key) ?? {
        key: proposal.key,
        sourceAddresses: [],
        routingClaims: [],
        runs: [],
        registration: 'requires six-field record and planning deduplication',
      };
      if (!entry.sourceAddresses.includes(proposal.sourceAddress))
        entry.sourceAddresses.push(proposal.sourceAddress);
      const ref = {
        id: run.id,
        attempt: run.attempt,
        artifact: proposal.artifact,
        cells: proposal.cells,
      };
      entry.runs.push(ref);
      let claim = entry.routingClaims.find(
        (c) =>
          c.address === proposal.address &&
          c.sourceAddress === proposal.sourceAddress &&
          c.owner === proposal.owner &&
          c.tier === proposal.tier
      );
      if (!claim) {
        claim = {
          address: proposal.address,
          sourceAddress: proposal.sourceAddress,
          owner: proposal.owner,
          tier: proposal.tier,
          runs: [],
        };
        entry.routingClaims.push(claim);
      }
      claim.runs.push(ref);
      all.set(proposal.key, entry);
    }
  }
  return [...all.values()].map((entry) => {
    const established = entry.routingClaims.filter((c) => !generic.has(c.address));
    const candidates = established.length ? established : entry.routingClaims;
    const routes = new Set(candidates.map((c) => JSON.stringify([c.address, c.owner])));
    const conflict = routes.size > 1;
    return {
      ...entry,
      address: conflict ? null : candidates[0].address,
      owner: conflict ? null : candidates[0].owner,
      tier: tiers[Math.max(...entry.routingClaims.map((c) => tiers.indexOf(c.tier)))],
      routingState: conflict ? 'conflict' : 'resolved',
    };
  });
}

export function consume(history, load, now) {
  if (history.schemaVersion !== 1) throw new Error('Unsupported history schema');
  const seen = new Set();
  const runs = history.runs.map((run) => {
    const id = `${run.id}:${run.attempt}`;
    if (seen.has(id)) throw new Error('Duplicate run/attempt');
    seen.add(id);
    return consumeRun(run, load);
  });
  const schedule = scheduleStatus(history.workflow, runs, now);
  const watchdog = history.watchdog ?? { state: 'not-measured' };
  const issues = (history.errors ?? []).map(() => issue('api-unavailable'));
  if (
    watchdog.state !== 'active' ||
    !iso(watchdog.lastCompletedAt) ||
    Date.parse(now) - Date.parse(watchdog.lastScheduledAt ?? watchdog.lastCompletedAt) >
      48 * 3600000 ||
    watchdog.conclusion !== 'success'
  )
    issues.push(issue('watchdog-not-observed-healthy'));
  return {
    schemaVersion: 1,
    asOf: now,
    state: issues.length ? 'not-measured' : schedule.state,
    aliases: { '#43B': ['#43C-report', '#43C-preview'] },
    schedule,
    watchdog: {
      state: watchdog.state,
      lastCompletedAt: watchdog.lastCompletedAt ?? null,
      lastScheduledAt: watchdog.lastScheduledAt ?? null,
      conclusion: watchdog.conclusion ?? null,
    },
    issues,
    runs,
    proposals: aggregateProposals(runs),
  };
}
export function markdown(report) {
  return [
    `# Frontend quality evidence`,
    '',
    `As of ${report.asOf}. Monitoring: **${report.state}**. Weekly schedule: **${report.schedule.state}**.`,
    '',
    'Observation job success does not establish a passing measurement. Coverage and original attempts remain separate.',
    '',
    '| Run / attempt | Event | Measured SHA (head separately in JSON) | State | Present / expected | Samples |',
    '| --- | --- | --- | --- | --- | --- |',
    ...report.runs.map(
      (r) =>
        `| [${r.id}/${r.attempt}](${r.url}) | ${r.event} | ${r.measuredSha} | ${r.state} | ${r.present}/${r.expected} | ${r.samples} |`
    ),
    '',
    ...(report.schedule.windows?.map(
      (w) =>
        `Weekly ${w.dueAt}: **${w.state}**; overdue ${w.overdueAt} (24h operational grace); late firing: ${w.late ? 'yes' : 'no'}; dev #43C-report.`
    ) ?? []),
    '',
    ...report.runs.flatMap((r) => [
      `Run ${r.id}/${r.attempt}: ${JSON.stringify(r.counts)}. Issues: ${r.issues.map((i) => i.reason).join(', ') || 'none'}.`,
      ...r.coverage.map(
        (c) =>
          `- Coverage ${c.route}: ${c.state}; ${c.owner} ${c.address}; source ${c.sourceAddress ?? 'unspecified'}; dependency ${c.dependency ?? 'see contract'}.`
      ),
      ...r.proposals.map(
        (p) =>
          `- Proposal ${p.key}: ${p.owner} ${p.address} (${p.tier}); source ${p.sourceAddress}; aliases ${(p.aliases ?? []).join(', ') || 'none'}.`
      ),
    ]),
    '',
    ...report.proposals.map(
      (p) =>
        `- ${p.routingState === 'conflict' ? 'Routing conflict' : 'Aggregate routing'} ${p.key}: ${p.owner ?? 'unresolved'} ${p.address ?? 'unresolved'} (${p.tier}); claims ${p.routingClaims.map((c) => `${c.owner} ${c.address} (${c.tier}), source ${c.sourceAddress}, runs ${c.runs.map((r) => `${r.id}/${r.attempt} artifact ${r.artifact} cells ${r.cells.join(',')}`).join(', ')}`).join('; ')}.`
    ),
    '',
    `Monitoring issues: ${report.issues.map((i) => i.reason).join(', ') || 'none'}.`,
    '',
    'First actual weekly firing requires a schedule event. Manual/main/local evidence cannot replace it. This watchdog is not independent external monitoring.',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const root = resolve(option('input') ?? '');
  const out = resolve(option('out') ?? '');
  const now = option('as-of');
  if (!option('input') || !option('out') || !iso(now) || existsSync(out))
    throw new Error('Use --input=DIR --as-of=ISO --out=NEW-DIR');
  const history = JSON.parse(readFileSync(join(root, 'history.json'), 'utf8'));
  const report = consume(
    history,
    (a) => {
      const path = resolve(root, a.path);
      if (relative(root, path).startsWith('..')) throw new Error('Artifact outside input');
      return JSON.parse(readFileSync(path, 'utf8'));
    },
    now
  );
  mkdirSync(out, { recursive: true, mode: 0o700 });
  writeFileSync(join(out, 'summary.json'), JSON.stringify(report, null, 2));
  writeFileSync(join(out, 'summary.md'), markdown(report));
  console.log(
    `Monitoring ${report.state}; schedule ${report.schedule.state}; ${report.runs.length} retained run attempts. ${out}`
  );
}
