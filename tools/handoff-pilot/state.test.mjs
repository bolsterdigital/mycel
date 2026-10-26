// Lifecycle fixtures exercise the authorization boundary without GitHub writes or agent launches.
// Rejected: tests that merely replay the happy-path implementation.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activationHeadEvidence,
  auditTaskToInspect,
  handoffEvidence,
  markLaunched,
  newRun as createRun,
  nextAction,
  pause,
  reconcilePending,
  recordResult,
  reserveSession as reserve,
  resume,
  scopeAllows,
  validateScopes,
  stop,
} from './state.mjs';

const scopesFor = (items) =>
  Object.fromEntries(items.map((item) => [item, { paths: [], directories: ['apps/web/'] }]));
function newRun(config, now) {
  return createRun({ scopes: scopesFor(config.allowlist), ...config }, now);
}
function reserveSession(state, session) {
  return reserve(state, { codeBase: 'e'.repeat(40), ...session });
}

const at = '2026-10-25T12:00:00.000Z';
// The time every check of a run started `at` happens: fixed, so no test depends on the real clock.
const soon = '2026-10-25T12:01:00.000Z';
const sha = (char) => char.repeat(40);
test('later main reuses reviewed runner only with unchanged bytes and fresh published preflight', () => {
  const evidence = {
    approvedMerge: sha('a'),
    localHead: sha('b'),
    remoteHead: sha('b'),
    preflightHead: sha('b'),
    approvedDigest: sha('c'),
    mergedDigest: sha('c'),
    workingDigest: sha('c'),
    preflightDigest: sha('c'),
    isAncestor: true,
    approvedConfig: sha('f'),
    preflightConfig: sha('f'),
    currentConfig: sha('f'),
  };
  assert.equal(activationHeadEvidence(evidence), true);
  for (const changed of [
    { isAncestor: false },
    { approvedConfig: undefined },
    { preflightConfig: sha('d') },
    { currentConfig: sha('d') },
    { remoteHead: sha('d') },
    { preflightHead: sha('a') },
    { mergedDigest: sha('d') },
    { workingDigest: sha('d') },
    { preflightDigest: sha('d') },
  ])
    assert.equal(
      activationHeadEvidence({ ...evidence, ...changed }),
      false,
      JSON.stringify(changed)
    );
});
function run(allowlist = ['#44', '#43A'], maxSessions = 8) {
  return newRun(
    { runId: 'pilot-1', lane: 'mbp', allowlist, maxSessions, maxRepairs: 2, maxMinutes: 360 },
    at
  );
}
function launch(state, id) {
  const action = nextAction(state, '2026-10-25T12:01:00.000Z');
  reserveSession(state, {
    id,
    item: action.item,
    phase: action.phase,
    model: action.phase === 'review' ? 'Astra' : 'Sol',
    startedAt: '2026-10-25T12:01:00.000Z',
  });
  markLaunched(state, 1000);
}
function result(state, id, outcome, extra = {}) {
  return {
    runId: state.runId,
    lane: state.lane,
    item: state.pending.item,
    phase: state.pending.phase,
    sessionId: id,
    codexThreadId: `thread-${id}`,
    outcome,
    pr: 60,
    headSha: sha('a'),
    reviewedHeadSha: sha('a'),
    planningCommit: sha('b'),
    reviewRecord: 'reference/review-pr60.md',
    mergeCommit: sha('c'),
    housekeepingCommit: sha('d'),
    finding: 'Concrete failed criterion',
    finishedAt: at,
    deviations: [],
    ...extra,
  };
}
const execution = {
  scopeVerified: true,
  scopeBase: sha('e'),
  scopeHead: sha('a'),
  pr: 60,
  headSha: sha('a'),
  planningCommit: sha('b'),
  merged: false,
  handoffCommitted: true,
};
const review = {
  pr: 60,
  headSha: sha('a'),
  merged: false,
  reviewRecordCommit: sha('b'),
  handoffCommitted: true,
};
const merge = {
  pr: 60,
  headSha: sha('a'),
  merged: true,
  mergeCommit: sha('c'),
  checksGreen: true,
  planningCommit: sha('d'),
  handoffCommitted: true,
  housekeepingVerified: true,
};

test('merged item accepts the next handoff tier after an exact-head merge', () => {
  const files = ['handoff/mbp.md'];
  const handoff = 'uitvoer\n# Bouw #11 D live preview, tier flagship-review';
  assert.equal(
    handoffEvidence({
      phase: 'merge',
      outcome: 'merged',
      files,
      handoff,
      currentTier: 'workhorse',
      nextItem: null,
      nextTier: null,
    }),
    true
  );
  assert.equal(
    handoffEvidence({
      phase: 'merge',
      outcome: 'merged',
      files,
      handoff,
      currentTier: 'workhorse',
      nextItem: '#43B',
      nextTier: 'workhorse',
    }),
    false
  );
  assert.equal(
    handoffEvidence({
      phase: 'audit',
      outcome: 'audit_done',
      files,
      handoff: 'uitvoer\n# Build #43B, tier workhorse',
      currentTier: 'flagship-review',
      nextItem: '#43B',
      nextTier: 'workhorse',
    }),
    true
  );
});
function executed(state) {
  launch(state, 'author');
  recordResult(state, result(state, 'author', 'pr_ready'), execution);
  return state;
}
function approved(state) {
  executed(state);
  launch(state, 'reviewer');
  recordResult(state, result(state, 'reviewer', 'approved'), review);
  return state;
}

test('a fresh session is reserved before launch and a duplicate cannot start', () => {
  const state = run();
  launch(state, 'author');
  assert.equal(nextAction(state, soon).kind, 'reconcile');
  assert.throws(() =>
    reserveSession(state, { id: 'author', item: '#44', phase: 'execute', startedAt: at })
  );
  assert.equal(state.sessions.length, 1);
});

test('execution requires GitHub head and published planning commit, not prose', () => {
  const state = run();
  launch(state, 'author');
  assert.throws(
    () =>
      recordResult(state, result(state, 'author', 'pr_ready'), { ...execution, headSha: sha('x') }),
    /not verified/
  );
  assert.equal(state.phase, 'execute');
  recordResult(state, result(state, 'author', 'pr_ready'), execution);
  assert.equal(state.phase, 'review');
  assert.equal(state.sessions[0].codexThreadId, 'thread-author');
});

test('a reviewer cannot be the author and approval is invalidated by head change', () => {
  const state = executed(run());
  launch(state, 'reviewer');
  assert.throws(
    () =>
      recordResult(
        state,
        result(state, 'reviewer', 'approved', { codexThreadId: 'thread-author' }),
        review
      ),
    /Fresh Codex thread/
  );
  state.items['#44'].authorSession = 'reviewer';
  assert.throws(
    () => recordResult(state, result(state, 'reviewer', 'approved'), review),
    /independent head/
  );
  state.items['#44'].authorSession = 'author';
  assert.throws(
    () =>
      recordResult(state, result(state, 'reviewer', 'approved'), { ...review, headSha: sha('x') }),
    /independent head/
  );
  recordResult(state, result(state, 'reviewer', 'approved'), review);
  launch(state, 'merger');
  assert.throws(
    () => recordResult(state, result(state, 'merger', 'merged'), { ...merge, headSha: sha('x') }),
    /approved head/
  );
});

test('review rejection creates a fresh repair session and another independent review', () => {
  const state = executed(run());
  launch(state, 'review-1');
  recordResult(
    state,
    result(state, 'review-1', 'changes_requested', { finding: 'navigation breaks at 200% zoom' }),
    review
  );
  assert.equal(state.phase, 'execute');
  launch(state, 'repair-1');
  recordResult(state, result(state, 'repair-1', 'pr_ready', { headSha: sha('e') }), {
    ...execution,
    scopeHead: sha('e'),
    headSha: sha('e'),
  });
  assert.equal(state.phase, 'review');
  assert.equal(state.items['#44'].approval, null);
  assert.notEqual(state.sessions[0].id, state.sessions[2].id);
});

test('repair and session limits stop the chain', () => {
  const state = run(['#44'], 8);
  for (let index = 0; index < 3; index++) {
    launch(state, `author-${index}`);
    recordResult(state, result(state, `author-${index}`, 'pr_ready'), execution);
    launch(state, `review-${index}`);
    recordResult(state, result(state, `review-${index}`, 'changes_requested'), review);
  }
  assert.equal(state.status, 'blocked');
  assert.equal(state.stopReason, 'repair-limit');
  const short = run(['#44'], 1);
  executed(short);
  assert.deepEqual(nextAction(short, soon).reason, 'session-limit');
  assert.equal(nextAction(run(), '2026-10-25T18:00:00.000Z').reason, 'wall-clock-limit');
});

test('pause blocks new launch and stop is terminal', () => {
  const state = run();
  pause(state);
  assert.equal(nextAction(state, soon).kind, 'halt');
  resume(state);
  assert.equal(nextAction(state, soon).kind, 'launch');
  stop(state);
  assert.equal(nextAction(state, soon).reason, 'operator-stop');
  assert.throws(() => resume(state));
});

test('recovery reuses verified result without repeating an earlier merge', () => {
  const state = approved(run());
  launch(state, 'merger');
  const proof = result(state, 'merger', 'merged', { planningCommit: sha('d') });
  reconcilePending(state, { childAlive: false, result: proof, external: merge });
  assert.equal(state.index, 1);
  assert.equal(state.items['#44'].mergeCommit, sha('c'));
  assert.deepEqual(nextAction(state, soon).item, '#43A');
  assert.throws(() => recordResult(state, proof, merge), /No launched session/);
});

test('interrupted session without independently verified result blocks', () => {
  const state = run();
  launch(state, 'author');
  reconcilePending(state, { childAlive: true });
  assert.equal(state.status, 'active');
  reconcilePending(state, { childAlive: false });
  assert.equal(state.stopReason, 'interrupted-without-proof');
});

test('merge needs green CI, housekeeping and the next committed handoff', () => {
  const state = approved(run());
  launch(state, 'merger');
  const proof = result(state, 'merger', 'merged', { planningCommit: sha('d') });
  assert.throws(
    () => recordResult(state, proof, { ...merge, checksGreen: false }),
    /external proof/
  );
  assert.throws(
    () => recordResult(state, proof, { ...merge, handoffCommitted: false }),
    /external proof/
  );
  recordResult(state, proof, merge);
  assert.equal(state.phase, 'execute');
});

test('evaluation observations are kept with the session, but do not authorize a merge', () => {
  const state = run();
  launch(state, 'author');
  const deviation = {
    expected: 'full labels',
    observed: 'clipped label',
    detection: '320px fixture',
    repair: 'stacked actions',
    cause: 'fixed width',
    preventionAddress: 'apps/web/e2e/admin.spec.ts',
    evidence: 'CI run 1',
  };
  assert.throws(
    () =>
      recordResult(state, result(state, 'author', 'pr_ready', { deviations: [deviation] }), {
        ...execution,
        headSha: sha('z'),
      }),
    /not verified/
  );
  recordResult(state, result(state, 'author', 'pr_ready', { deviations: [deviation] }), execution);
  assert.equal(state.deviations[0].preventionAddress, deviation.preventionAddress);
});

test('threshold routes to a separate claimed audit before the next item', () => {
  const state = approved(run());
  launch(state, 'merger');
  const proof = result(state, 'merger', 'merged', { planningCommit: sha('d') });
  recordResult(state, proof, {
    ...merge,
    auditTask: { threshold_met: true, exists: true, task_id: 'reorg-1', status: 'open' },
  });
  assert.deepEqual(nextAction(state, soon).phase, 'audit');
  assert.deepEqual(nextAction(state, soon).item, '#44');
  launch(state, 'auditor');
  assert.throws(
    () =>
      recordResult(state, result(state, 'auditor', 'audit_done'), {
        auditTask: { id: 'reorg-1', status: 'claimed', owner: { lane: 'mbp' } },
        handoffCommitted: true,
      }),
    /unverified/
  );
  assert.throws(
    () =>
      recordResult(state, result(state, 'auditor', 'audit_done'), {
        auditTask: { id: 'reorg-1', status: 'done' },
        handoffCommitted: false,
      }),
    /unverified/
  );
  recordResult(state, result(state, 'auditor', 'audit_done'), {
    auditTask: { id: 'reorg-1', status: 'done' },
    handoffCommitted: true,
  });
  assert.deepEqual(nextAction(state, soon).item, '#43A');
  assert.equal(state.sessions.length, 4);
});

test('a dev lane audit claim leaves the mbp continuation intact', () => {
  const state = approved(run());
  launch(state, 'merger');
  recordResult(state, result(state, 'merger', 'merged', { planningCommit: sha('d') }), {
    ...merge,
    auditTask: {
      threshold_met: true,
      exists: true,
      task_id: 'reorg-1',
      status: 'claimed',
      owner: { lane: 'dev' },
    },
  });
  assert.deepEqual(nextAction(state, soon).item, '#43A');
  assert.equal(state.auditTask, null);
});

test('audit taken by dev still requires the published mbp handoff', () => {
  const state = approved(run());
  launch(state, 'merger');
  recordResult(state, result(state, 'merger', 'merged', { planningCommit: sha('d') }), {
    ...merge,
    auditTask: { threshold_met: true, exists: true, task_id: 'reorg-1', status: 'open' },
  });
  launch(state, 'auditor');
  const proof = result(state, 'auditor', 'audit_taken_elsewhere');
  const auditTask = { id: 'reorg-1', status: 'claimed', owner: { lane: 'dev' } };
  assert.throws(
    () => recordResult(state, proof, { auditTask, handoffCommitted: false }),
    /unverified/
  );
  recordResult(state, proof, { auditTask, handoffCommitted: true });
  assert.deepEqual(nextAction(state, soon).item, '#43A');
});

test('ordinary handoffs do not inspect an audit ref before the threshold', () => {
  const state = run(['#44']);
  assert.equal(auditTaskToInspect(state, { threshold_met: false, task_id: 'not-created' }), null);
  assert.equal(auditTaskToInspect(state, { threshold_met: true, task_id: 'due-task' }), 'due-task');
  state.auditTask = { id: 'registered-task', item: '#44' };
  assert.equal(
    auditTaskToInspect(state, { threshold_met: false, task_id: 'later-task' }),
    'registered-task'
  );
});

test('wall-clock configuration cannot exceed the six-hour pilot ceiling', () => {
  assert.throws(
    () =>
      newRun({
        runId: 'oversize',
        lane: 'mbp',
        allowlist: ['#44'],
        maxSessions: 8,
        maxRepairs: 2,
        maxMinutes: 361,
      }),
    /1 to 360 minutes/
  );
  assert.equal(run(['#44']).maxMinutes, 360);
});

test('new runs require closed scopes and reservations pin the original repair base', () => {
  const config = {
    runId: 'scope',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  };
  assert.throws(() => createRun(config), /file scope/);
  for (const path of [
    '/',
    './',
    '../apps/',
    '/apps/',
    'apps/*/',
    'apps/**',
    'apps/../scripts/',
    'apps//web/',
    'apps/\\web/',
    'tools/',
    'docs/',
    'tools/handoff-pilot/',
    'docs/plans/',
    '.git/',
    'apps/\nweb/',
  ]) {
    assert.throws(
      () => createRun({ ...config, scopes: { '#44': { paths: [], directories: [path] } } }),
      /scope/,
      JSON.stringify(path)
    );
  }
  const state = run();
  assert.throws(
    () => reserve(state, { id: 'missing', item: '#44', phase: 'execute', startedAt: soon }),
    /code base/
  );
  launch(state, 'first');
  const base = state.items['#44'].scopeBase;
  assert.equal(state.pending.codeBase, base);
  state.pending = null;
  reserveSession(state, {
    id: 'repair',
    item: '#44',
    phase: 'execute',
    codeBase: sha('f'),
    startedAt: soon,
  });
  assert.equal(state.items['#44'].scopeBase, base);
  assert.equal(state.pending.scopeBase, base);
  assert.equal(state.pending.codeBase, sha('f'));
});

test('green PR evidence cannot replace independent scope proof', () => {
  for (const change of [
    { scopeVerified: false },
    { scopeBase: sha('f') },
    { scopeHead: sha('f') },
  ]) {
    const state = run();
    launch(state, 'execute');
    assert.throws(
      () => recordResult(state, result(state, 'execute', 'pr_ready'), { ...execution, ...change }),
      /scope/
    );
    assert.equal(state.phase, 'execute');
    assert.equal(state.pending.id, 'execute');
  }
});

test('SvelteKit scope components are literal exact paths and bounded directories', () => {
  const exact = 'apps/web/src/routes/(admin)/admin/[tenant]/site/+page.server.ts';
  const directory = 'apps/web/src/routes/(admin)/admin/[tenant]/site/';
  const sitemap = 'apps/web/src/routes/(public)/[tenant]/sitemap.xml/+server.ts';
  const scope = { paths: [exact, sitemap], directories: [directory] };
  assert.equal(validateScopes({ allowlist: ['#38'], scopes: { '#38': scope } })['#38'], scope);
  for (const path of [exact, sitemap, `${directory}nested/+page.svelte`])
    assert.equal(scopeAllows(scope, path), true, path);
  for (const path of [
    exact.replace('[tenant]', '[site]'),
    exact.replace('[tenant]', 't'),
    exact.replace('(admin)', 'admin'),
    exact.replace('/site/', '/site-extra/'),
    exact.replace('/site/', '/status/'),
    sitemap.replace('[tenant]', '[site]'),
    `${directory}AGENTS.md`,
    `${directory}.git/config`,
  ])
    assert.equal(scopeAllows(scope, path), false, path);
});

test('route syntax rejects malformed components and authority outside the route root', () => {
  const root = 'apps/web/src/routes/';
  for (const path of [
    `${root}(admin|public)/+page.ts`,
    `${root}(.*)/+page.ts`,
    `${root}(admin)?/+page.ts`,
    `${root}()/+page.ts`,
    `${root}prefix(admin)/+page.ts`,
    `${root}[a-z]/+page.ts`,
    `${root}[tenant*]/+page.ts`,
    `${root}[tenant]/../+page.ts`,
    `${root}(admin)/CLAUDE.md`,
    `${root}(admin)/.git/config`,
    'apps/web/src/lib/(admin)/file.ts',
    'apps/web/src/routes-other/[tenant]/file.ts',
    'tools/handoff-pilot/[tenant]/file.ts',
    'docs/plans/(admin)/file.ts',
    `${root}[tenant]/bad\\file.ts`,
    `${root}[tenant]/bad\nfile.ts`,
  ]) {
    for (const scope of [
      { paths: [path], directories: [] },
      { paths: [], directories: [path + '/'] },
    ])
      assert.throws(
        () => validateScopes({ allowlist: ['#38'], scopes: { '#38': scope } }),
        /scope/,
        path
      );
  }
});

// These are filesystem names from the actual public/preview tree, not URL patterns.
test('real public route grammar stays literal for optional, rest and matcher components', () => {
  const root = 'apps/web/src/routes/(public)/[tenant]/';
  for (const component of ['[[locale=locale]]', '[[locale]]', '[locale=locale]', '[...path]']) {
    const directory = `${root}${component}/`;
    const exact = `${directory}+page.svelte`;
    const scope = { paths: [exact], directories: [] };
    const prefix = { paths: [], directories: [directory] };
    for (const value of [scope, prefix]) {
      validateScopes({ allowlist: ['#9 PR 1'], scopes: { '#9 PR 1': value } });
      assert.equal(scopeAllows(value, exact), true);
      for (const other of [
        exact.replace(component, 'nl'),
        exact.replace(component, '[other]'),
        exact.replace(component, `${component}suffix`),
        `${directory}AGENTS.md`,
      ])
        assert.equal(scopeAllows(value, other), false, other);
    }
  }
  const exact = `${root}[[locale=locale]]/[...path]/+page.svelte`;
  validateScopes({
    allowlist: ['#9 PR 1'],
    scopes: { '#9 PR 1': { paths: [exact], directories: [] } },
  });
  for (const component of [
    '[[...path]]',
    '[...path=matcher]',
    '[locale=]',
    '[=locale]',
    '[[locale=foo=bar]]',
    '[locale=a-z]',
    '[[locale]',
    '[....path]',
    '[...path*]',
    'prefix[locale=locale]',
  ])
    for (const value of [
      { paths: [`${root}${component}/+page.ts`], directories: [] },
      { paths: [], directories: [`${root}${component}/`] },
    ])
      assert.throws(
        () => validateScopes({ allowlist: ['#9 PR 1'], scopes: { '#9 PR 1': value } }),
        /scope/,
        component
      );
  for (const path of [
    'apps/web/src/lib/[[locale]]/file.ts',
    'apps/web/src/routes-other/[...path]/file.ts',
  ])
    assert.throws(
      () =>
        validateScopes({
          allowlist: ['#9 PR 1'],
          scopes: { '#9 PR 1': { paths: [path], directories: [] } },
        }),
      /scope/,
      path
    );
});
