// A persisted, bounded transition ledger keeps a crashed supervisor from treating an agent's
// prose or exit status as delivery. Rejected: deriving progress from the latest handoff text.
export const PHASES = ['execute', 'review', 'merge', 'audit'];

// A later published main may reuse the independently reviewed runner only while its bytes
// match the reviewed merge and the new preflight names that exact later head. Rejected: pinning
// activation to one main HEAD, which prevents a second bounded run after ordinary code merges.
export function activationHeadEvidence({
  approvedMerge,
  localHead,
  remoteHead,
  preflightHead,
  approvedDigest,
  mergedDigest,
  workingDigest,
  preflightDigest,
  isAncestor,
  approvedConfig,
  preflightConfig,
  currentConfig,
}) {
  return (
    Boolean(approvedMerge && localHead && approvedDigest && isAncestor && currentConfig) &&
    approvedConfig === currentConfig &&
    preflightConfig === currentConfig &&
    localHead === remoteHead &&
    localHead === preflightHead &&
    approvedDigest === mergedDigest &&
    approvedDigest === workingDigest &&
    approvedDigest === preflightDigest
  );
}

// Closed path data is authority; child-reported paths never grant it. Rejected: globs and
// implicit root prefixes, which can silently admit runner or planning changes.
export function validateScopes(config) {
  const scopes = config.scopes;
  if (
    !scopes ||
    typeof scopes !== 'object' ||
    Array.isArray(scopes) ||
    Object.keys(scopes).length !== config.allowlist.length ||
    Object.keys(scopes).some((item) => !config.allowlist.includes(item))
  )
    throw new Error('Each allowlisted item needs a closed file scope');
  for (const item of config.allowlist) {
    const scope = scopes[item];
    if (
      !scope ||
      Object.keys(scope).sort().join(',') !== 'directories,paths' ||
      !Array.isArray(scope.paths) ||
      !Array.isArray(scope.directories) ||
      scope.paths.length + scope.directories.length === 0
    )
      throw new Error(`Invalid file scope for ${item}`);
    for (const [kind, entries] of Object.entries(scope)) {
      for (const path of entries) {
        const directory = kind === 'directories';
        const plain = directory && typeof path === 'string' ? path.slice(0, -1) : path;
        if (
          typeof path !== 'string' ||
          !path ||
          directory !== path.endsWith('/') ||
          /[\\\x00-\x1f\x7f*?{}:]/.test(path) ||
          plain.split('/').some((part) => {
            if (!part || part === '.' || part === '..') return true;
            if (!/[()[\]]/.test(part)) return false;
            // Only whole supported SvelteKit filesystem components are admitted. Optional,
            // rest and matcher names remain literal, never URL patterns or glob authority.
            return (
              !plain.startsWith('apps/web/src/routes/') ||
              !/^(?:\([A-Za-z_][A-Za-z0-9_-]*\)|\[(?:[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z_][A-Za-z0-9_]*)?|\.\.\.[A-Za-z_][A-Za-z0-9_]*)\]|\[\[[A-Za-z_][A-Za-z0-9_]*(?:=[A-Za-z_][A-Za-z0-9_]*)?\]\])$/.test(
                part
              )
            );
          }) ||
          path.startsWith('-') ||
          forbiddenPath(plain) ||
          (directory && ['tools', 'docs'].includes(plain))
        )
          throw new Error(`Invalid scope path for ${item}: ${JSON.stringify(path)}`);
      }
    }
  }
  return scopes;
}

export function forbiddenPath(path) {
  return (
    ['.git', '.claude', '.agents', 'tools/handoff-pilot', 'docs/plans'].some(
      (root) => path === root || path.startsWith(`${root}/`)
    ) || path.split('/').some((part) => ['AGENTS.md', 'CLAUDE.md', '.git'].includes(part))
  );
}

export function scopeAllows(scope, path) {
  return (
    !forbiddenPath(path) &&
    (scope.paths.includes(path) ||
      scope.directories.some((directory) => path.startsWith(directory)))
  );
}

export function newRun(config, now = new Date().toISOString()) {
  if (config.lane !== 'mbp') throw new Error('The pilot is limited to the mbp lane');
  if (
    !Array.isArray(config.allowlist) ||
    config.allowlist.length < 1 ||
    config.allowlist.length > 2
  )
    throw new Error('Allowlist must contain one or two items');
  if (new Set(config.allowlist).size !== config.allowlist.length) throw new Error('Duplicate item');
  const scopes = structuredClone(validateScopes(config));
  if (!Number.isInteger(config.maxSessions) || config.maxSessions < 1 || config.maxSessions > 8)
    throw new Error('Session limit must be 1 to 8');
  if (!Number.isInteger(config.maxRepairs) || config.maxRepairs < 0 || config.maxRepairs > 2)
    throw new Error('Repair limit must be 0 to 2');
  if (!Number.isInteger(config.maxMinutes) || config.maxMinutes < 1 || config.maxMinutes > 360)
    throw new Error('Wall clock limit must be 1 to 360 minutes');
  return {
    schema: 2,
    scopes,
    runId: config.runId,
    lane: config.lane,
    allowlist: config.allowlist,
    maxSessions: config.maxSessions,
    maxRepairs: config.maxRepairs,
    maxMinutes: config.maxMinutes,
    startedAt: now,
    status: 'active',
    index: 0,
    phase: 'execute',
    sessions: [],
    repairs: {},
    items: {},
    auditTask: null,
    pending: null,
    events: [],
    deviations: [],
    stopReason: null,
  };
}

export function currentItem(state) {
  return state.allowlist[state.index] ?? null;
}

export function auditTaskToInspect(state, ledger) {
  return state.auditTask?.id ?? (ledger.threshold_met ? ledger.task_id : null);
}

export function handoffEvidence({
  phase,
  outcome,
  files,
  handoff,
  currentTier,
  nextItem,
  nextTier,
  pr,
  headSha,
}) {
  if (!files.includes('handoff/mbp.md')) return false;
  const phaseWord =
    phase === 'execute'
      ? 'review'
      : phase === 'review'
        ? outcome === 'approved'
          ? 'merge'
          : 'uitvoer'
        : 'uitvoer';
  if (!handoff.toLowerCase().includes(phaseWord)) return false;
  if (phase === 'merge' || phase === 'audit')
    return !nextItem || (handoff.includes(nextItem) && handoff.includes(nextTier));
  return handoff.includes(currentTier) && handoff.includes(`#${pr}`) && handoff.includes(headSha);
}

// `now` has no default: a test that left it out ran against the real clock and broke once the
// fixture run was older than its wall-clock limit (2026-10-25, TODO #27). Callers pass the time.
export function nextAction(state, now) {
  if (typeof now !== 'string') throw new TypeError('nextAction needs the current time');
  if (state.status !== 'active') return { kind: 'halt', reason: state.stopReason ?? state.status };
  if (Date.parse(now) - Date.parse(state.startedAt) >= state.maxMinutes * 60_000)
    return { kind: 'halt', reason: 'wall-clock-limit' };
  if (state.pending) return { kind: 'reconcile', pending: state.pending };
  const item = state.phase === 'audit' ? state.auditTask?.item : currentItem(state);
  if (!item) return { kind: 'halt', reason: 'allowlist-complete' };
  if (state.sessions.length >= state.maxSessions) return { kind: 'halt', reason: 'session-limit' };
  return { kind: 'launch', item, phase: state.phase };
}

export function pause(state) {
  if (state.status === 'active') state.status = 'paused';
  return state;
}

export function resume(state) {
  if (state.status !== 'paused') throw new Error('Run is not paused');
  state.status = 'active';
  return state;
}

export function stop(state, reason = 'operator-stop') {
  state.status = 'stopped';
  state.stopReason = reason;
  return state;
}

export function reserveSession(state, session) {
  const action = nextAction(state, session.startedAt);
  if (action.kind !== 'launch') throw new Error(`Cannot launch: ${action.reason ?? action.kind}`);
  if (action.item !== session.item || action.phase !== session.phase)
    throw new Error('Unexpected item or phase');
  if (state.sessions.some((entry) => entry.id === session.id))
    throw new Error('Duplicate session id');
  if (session.phase === 'execute') {
    if (!/^[0-9a-f]{40}$/.test(session.codeBase ?? ''))
      throw new Error('Execution reservation needs a published code base');
    const item = state.items[session.item] ?? {};
    item.scopeBase ??= session.codeBase;
    state.items[session.item] = item;
  }
  state.pending = {
    ...session,
    scopeBase: state.items[session.item]?.scopeBase,
    status: 'reserved',
  };
  return state;
}

export function markLaunched(state, childPid) {
  if (!state.pending || state.pending.status !== 'reserved') throw new Error('No reservation');
  state.pending.status = 'launched';
  state.pending.childPid = childPid;
  state.sessions.push({ ...state.pending });
  return state;
}

export function recordResult(state, result, external) {
  const pending = state.pending;
  if (!pending || pending.status !== 'launched') throw new Error('No launched session');
  if (
    result.runId !== state.runId ||
    result.item !== pending.item ||
    result.lane !== state.lane ||
    result.phase !== pending.phase ||
    result.sessionId !== pending.id
  )
    throw new Error('Technical result does not match reservation');
  if (
    !result.codexThreadId ||
    state.sessions.some(
      (entry) => entry.id !== pending.id && entry.codexThreadId === result.codexThreadId
    )
  )
    throw new Error('Fresh Codex thread is missing or reused');
  const item = state.items[pending.item] ?? {};
  if (!Array.isArray(result.deviations)) throw new Error('Missing evaluation observations');
  for (const deviation of result.deviations) {
    if (
      !deviation.expected ||
      !deviation.observed ||
      !deviation.detection ||
      !deviation.repair ||
      !deviation.cause ||
      !deviation.preventionAddress ||
      !deviation.evidence
    )
      throw new Error('Incomplete evaluation observation');
  }
  if (
    pending.phase === 'execute' &&
    (!external.scopeVerified ||
      external.scopeBase !== item.scopeBase ||
      external.scopeHead !== result.headSha)
  )
    throw new Error('Execution file scope lacks independent Git proof');
  if (pending.phase === 'execute') {
    if (
      result.outcome !== 'pr_ready' ||
      !result.pr ||
      !result.headSha ||
      !result.planningCommit ||
      external.pr !== result.pr ||
      external.headSha !== result.headSha ||
      external.planningCommit !== result.planningCommit ||
      external.merged ||
      !external.handoffCommitted
    )
      throw new Error('Execution handoff is not verified against Git and GitHub');
    item.pr = result.pr;
    item.headSha = result.headSha;
    item.planningCommit = result.planningCommit;
    item.authorSession = pending.id;
    item.approval = null;
    state.phase = 'review';
  } else if (pending.phase === 'review') {
    if (
      pending.id === item.authorSession ||
      !item.pr ||
      !item.headSha ||
      external.pr !== item.pr ||
      external.headSha !== item.headSha ||
      external.merged
    )
      throw new Error('Review has no stable independent head');
    if (result.outcome === 'changes_requested') {
      if (
        !result.finding ||
        !result.reviewRecord ||
        !external.handoffCommitted ||
        external.reviewRecordCommit !== result.planningCommit
      )
        throw new Error('Rejected review lacks a published record or repair handoff');
      const count = (state.repairs[pending.item] ?? 0) + 1;
      state.repairs[pending.item] = count;
      if (count > state.maxRepairs) return block(state, pending, 'repair-limit');
      item.approval = null;
      state.phase = 'execute';
      state.events.push({
        kind: 'repair',
        item: pending.item,
        sessionId: pending.id,
        at: result.finishedAt,
        finding: result.finding ?? null,
      });
    } else if (
      result.outcome === 'approved' &&
      result.reviewedHeadSha === item.headSha &&
      result.reviewRecord &&
      external.reviewRecordCommit === result.planningCommit &&
      external.handoffCommitted
    ) {
      item.approval = {
        headSha: item.headSha,
        sessionId: pending.id,
        record: result.reviewRecord,
        planningCommit: result.planningCommit,
      };
      state.phase = 'merge';
    } else {
      throw new Error('Review approval or review record is unverified');
    }
  } else if (pending.phase === 'merge') {
    if (
      !item.approval ||
      item.approval.headSha !== item.headSha ||
      pending.id === item.authorSession ||
      pending.id === item.approval.sessionId ||
      external.headSha !== item.approval.headSha
    )
      throw new Error('Merge head differs from independently approved head');
    if (
      result.outcome !== 'merged' ||
      result.pr !== item.pr ||
      !external.merged ||
      external.mergeCommit !== result.mergeCommit ||
      !external.checksGreen ||
      !result.housekeepingCommit ||
      external.planningCommit !== result.planningCommit ||
      !external.handoffCommitted ||
      !external.housekeepingVerified
    )
      throw new Error('Merge, housekeeping or handoff lacks external proof');
    item.mergeCommit = result.mergeCommit;
    item.housekeepingCommit = result.housekeepingCommit;
    item.planningCommit = result.planningCommit;
    item.completed = true;
    state.index += 1;
    const audit = external.auditTask;
    if (audit?.threshold_met && audit.exists && audit.status === 'open') {
      state.auditTask = { id: audit.task_id, item: pending.item };
      state.phase = 'audit';
    } else if (
      audit?.threshold_met &&
      audit.exists &&
      (audit.status === 'done' || (audit.status === 'claimed' && audit.owner?.lane === 'dev'))
    ) {
      state.phase = 'execute';
    } else if (audit?.threshold_met) {
      throw new Error('Triggered audit task is not registered or held by another lane');
    } else {
      state.phase = 'execute';
    }
  } else if (pending.phase === 'audit') {
    if (
      result.outcome === 'audit_done' &&
      external.auditTask?.id === state.auditTask?.id &&
      external.auditTask.status === 'done' &&
      external.handoffCommitted
    ) {
      state.events.push({
        kind: 'audit',
        taskId: state.auditTask.id,
        outcome: 'done',
        sessionId: pending.id,
      });
    } else if (
      result.outcome === 'audit_taken_elsewhere' &&
      external.auditTask?.id === state.auditTask?.id &&
      external.auditTask.status === 'claimed' &&
      external.auditTask.owner?.lane === 'dev' &&
      external.handoffCommitted
    ) {
      state.events.push({
        kind: 'audit',
        taskId: state.auditTask.id,
        outcome: 'dev-claim',
        sessionId: pending.id,
      });
    } else {
      throw new Error('Audit completion or competing dev claim is unverified');
    }
    state.auditTask = null;
    state.phase = 'execute';
  }
  state.items[pending.item] = item;
  const session = state.sessions.find((entry) => entry.id === pending.id);
  session.codexThreadId = result.codexThreadId ?? null;
  state.deviations.push(
    ...result.deviations.map((entry) => ({
      ...entry,
      item: pending.item,
      phase: pending.phase,
      sessionId: pending.id,
    }))
  );
  state.events.push({
    kind: 'session',
    item: pending.item,
    phase: pending.phase,
    sessionId: pending.id,
    model: pending.model,
    at: result.finishedAt,
    outcome: result.outcome,
  });
  session.status = 'completed';
  state.pending = null;
  if (state.index >= state.allowlist.length && !state.auditTask) {
    state.status = 'complete';
    state.stopReason = 'allowlist-complete';
  }
  return state;
}

function block(state, pending, reason) {
  state.status = 'blocked';
  state.stopReason = reason;
  state.events.push({
    kind: 'block',
    item: pending.item,
    phase: pending.phase,
    sessionId: pending.id,
    reason,
  });
  state.sessions.find((entry) => entry.id === pending.id).status = 'completed';
  state.pending = null;
  return state;
}

export function reconcilePending(state, evidence) {
  if (!state.pending) return state;
  if (evidence.childAlive) return state;
  if (evidence.result && evidence.external)
    return recordResult(state, evidence.result, evidence.external);
  return block(state, state.pending, 'interrupted-without-proof');
}
