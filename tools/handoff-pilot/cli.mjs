#!/usr/bin/env node
// This local supervisor starts fresh Codex threads from the ordinary mbp handoff and verifies
// each transition against GitHub and the published planning repo. Rejected: using agent exit 0,
// a handoff sentence or a local planning commit as proof that the next step is safe.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  auditTaskToInspect,
  currentItem,
  handoffEvidence,
  markLaunched,
  newRun,
  nextAction,
  pause,
  reconcilePending,
  recordResult,
  reserveSession,
  resume,
  stop,
} from './state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const planning = resolve(process.env.MYCEL_PILOT_PLANNING ?? resolve(repo, '../mycel-planning'));
const home =
  process.env.MYCEL_PILOT_HOME ??
  join(homedir(), 'Library/Application Support/mycel-handoff-pilot');
const sharedTask = join(homedir(), '.claude/bin/shared-task');
const stateFile = join(home, 'state.json');
const lockDir = join(home, 'mbp.lock');
const args = process.argv.slice(2);
const command = args[0];

function shell(file, argv, cwd = repo, timeout = 30_000) {
  return execFileSync(file, argv, {
    cwd,
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function optionalShell(file, argv, cwd = repo) {
  try {
    return shell(file, argv, cwd);
  } catch {
    return '';
  }
}
function json(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function ensureHome() {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}
function save(state) {
  ensureHome();
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, stateFile);
}
function load() {
  if (!existsSync(stateFile)) throw new Error('No pilot run; use start');
  return json(stateFile);
}
function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    const processState = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000,
    });
    return processState.status === 0 && !processState.stdout.trim().startsWith('Z');
  } catch {
    return false;
  }
}
function groupAlive(pgid) {
  if (!pgid) return false;
  const processes = spawnSync('/bin/ps', ['-A', '-o', 'pgid=,stat='], {
    encoding: 'utf8',
    timeout: 1000,
  });
  if (processes.status !== 0) return true;
  return processes.stdout.split('\n').some((line) => {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line);
    return match && Number(match[1]) === pgid && !match[2].startsWith('Z');
  });
}
function ctl(name) {
  return join(home, name);
}
function fail(reason) {
  throw new Error(reason);
}
function runId() {
  return (
    new Date()
      .toISOString()
      .replaceAll(/[^\dT]/g, '')
      .slice(0, 15) +
    '-' +
    randomUUID().slice(0, 8)
  );
}
function toolExists(name) {
  return spawnSync('/usr/bin/env', ['which', name], { encoding: 'utf8' }).status === 0;
}
function shaFiles() {
  const hash = createHash('sha256');
  for (const name of ['cli.mjs', 'state.mjs', 'result.schema.json'])
    hash.update(readFileSync(join(here, name)));
  return hash.digest('hex');
}
function model(phase, tier) {
  const kind =
    phase === 'execute'
      ? 'uitvoer'
      : phase === 'merge'
        ? 'merge'
        : phase === 'audit'
          ? 'reorg-audit'
          : 'review';
  const selected = shell('model-mode', ['name-for', kind, tier, 'codex']);
  const flagship = shell('model-mode', ['name', 'stuur', 'codex']);
  const workhorse = shell('model-mode', ['name', 'uitvoer', 'codex']);
  const role =
    selected === flagship
      ? 'stuur'
      : selected === workhorse
        ? 'uitvoer'
        : fail(`Unknown model name ${selected}`);
  return { name: selected, id: shell('model-mode', ['get', role, 'codex']) };
}
function codexBaseArgs(modelId) {
  return ['exec', '--json', '--approve-for-me', '-C', repo, '--add-dir', planning, '-m', modelId];
}
function config(path) {
  const value = json(resolve(path));
  if (
    value.lane !== 'mbp' ||
    value.repo !== 'bolsterdigital/mycel' ||
    resolve(repo, value.planning) !== planning
  )
    fail('Config must target this mbp lane, GitHub repo and local planning sibling');
  if (!value.tiers || Object.keys(value.tiers).some((item) => !value.allowlist.includes(item)))
    fail('Each allowlisted item needs a tier');
  for (const item of value.allowlist)
    if (!['workhorse', 'flagship-review', 'flagship-only'].includes(value.tiers[item]))
      fail(`Invalid tier for ${item}`);
  if (
    value.notifyCommand !== undefined &&
    (typeof value.notifyCommand !== 'string' || !value.notifyCommand.trim())
  )
    fail('notifyCommand must name one executable, without arguments');
  return value;
}
function publishedPlanning() {
  const local = shell('git', ['rev-parse', 'HEAD'], planning);
  const remote = shell('git', ['ls-remote', 'origin', 'refs/heads/main'], planning).split(/\s+/)[0];
  return { local, remote };
}
function prEvidence(pr) {
  const data = JSON.parse(
    shell('gh', [
      'pr',
      'view',
      String(pr),
      '-R',
      'bolsterdigital/mycel',
      '--json',
      'number,headRefOid,mergedAt,mergeCommit,statusCheckRollup',
    ])
  );
  const checks = data.statusCheckRollup ?? [];
  const required = new Set(['verify', 'security', 'image', 'compose']);
  const green =
    checks.every((check) => (check.conclusion ?? check.state) === 'SUCCESS') &&
    [...required].every((name) =>
      checks.some((check) => check.name === name && check.conclusion === 'SUCCESS')
    );
  return {
    pr: data.number,
    headSha: data.headRefOid,
    merged: !!data.mergedAt,
    mergeCommit: data.mergeCommit?.oid ?? null,
    checksGreen: green,
  };
}
function externalFor(state, result) {
  const item = state.items[state.pending.item] ?? {};
  const pr = prEvidence(result.pr ?? item.pr);
  const plan = publishedPlanning();
  if (plan.local !== plan.remote) fail('Planning main is not published');
  const previousPlanning =
    state.pending.phase === 'execute'
      ? (item.planningCommit ?? state.config.baselinePlanningCommit)
      : state.pending.phase === 'review'
        ? item.planningCommit
        : state.pending.phase === 'merge'
          ? item.approval?.planningCommit
          : item.planningCommit;
  if (!previousPlanning) fail('Missing prior planning commit for handoff comparison');
  shell('git', ['merge-base', '--is-ancestor', previousPlanning, plan.local], planning);
  const files = shell(
    'git',
    ['diff', '--name-only', `${previousPlanning}..${plan.local}`],
    planning
  ).split('\n');
  if (files.includes('handoff/dev.md')) fail('The mbp chain changed the dev handoff');
  const handoff = readFileSync(join(planning, 'handoff/mbp.md'), 'utf8');
  const nextItem =
    state.pending.phase === 'audit'
      ? state.allowlist[state.index]
      : state.allowlist[state.index + 1];
  const handoffValid = handoffEvidence({
    phase: state.pending.phase,
    outcome: result.outcome,
    files,
    handoff,
    currentTier: state.config.tiers[state.pending.item],
    nextItem,
    nextTier: nextItem ? state.config.tiers[nextItem] : null,
    pr: result.pr ?? item.pr,
    headSha: state.pending.phase === 'execute' ? result.headSha : item.headSha,
  });
  const housekeepingFiles = ['TODO.md', 'done/register.md', '_reconcile/drift-log.md'];
  const housekeepingVerified =
    !!result.housekeepingCommit &&
    plan.remote === result.housekeepingCommit &&
    housekeepingFiles.every((file) => files.includes(file)) &&
    readFileSync(join(planning, '_reconcile/drift-log.md'), 'utf8').includes(`PR #${item.pr}`);
  const ledger = JSON.parse(
    shell(sharedTask, ['ledger-status', '--ledger', join(planning, '_reconcile/drift-log.md')])
  );
  const taskId = auditTaskToInspect(state, ledger);
  const inspection = taskId
    ? optionalShell(sharedTask, ['--repo', repo, 'inspect', '--id', taskId])
    : '';
  const inspected = inspection ? JSON.parse(inspection) : null;
  const reviewRecordValid =
    state.pending.phase === 'review' &&
    result.reviewRecord?.startsWith('reference/') &&
    files.includes(result.reviewRecord) &&
    shell('git', ['show', `${plan.local}:${result.reviewRecord}`], planning).includes(item.headSha);
  return {
    ...pr,
    planningCommit: plan.remote,
    reviewRecordCommit: reviewRecordValid ? plan.remote : null,
    handoffCommitted: handoffValid,
    housekeepingVerified,
    auditTask: state.pending.phase === 'audit' ? inspected : { ...ledger, ...inspected },
  };
}
function verifyActivation(approval, proof) {
  const head = shell('git', ['rev-parse', 'HEAD']);
  if (
    approval.outcome !== 'approved' ||
    !approval.runnerPr ||
    !approval.reviewSessionId ||
    !approval.authorSessionId ||
    approval.reviewSessionId === approval.authorSessionId ||
    !approval.reviewRecord?.startsWith('reference/') ||
    !approval.approvedHeadSha ||
    !approval.mergedSha ||
    !approval.planningCommit ||
    approval.codeDigest !== shaFiles() ||
    proof.codeDigest !== shaFiles() ||
    proof.codeHead !== head ||
    approval.mergedSha !== head
  )
    fail('Independent activation record does not match this merged runner');
  const pr = prEvidence(approval.runnerPr);
  if (
    !pr.merged ||
    pr.headSha !== approval.approvedHeadSha ||
    pr.mergeCommit !== approval.mergedSha ||
    !pr.checksGreen
  )
    fail('Runner PR is not merged from the independently approved green head');
  const record = shell(
    'git',
    ['show', `${approval.planningCommit}:${approval.reviewRecord}`],
    planning
  );
  if (
    !record.includes(approval.approvedHeadSha) ||
    !record.includes(approval.reviewSessionId) ||
    !/approved|goedgekeurd/i.test(record)
  )
    fail('Published review record lacks exact approval evidence');
  shell('git', ['cat-file', '-e', `${approval.planningCommit}:${approval.reviewRecord}`], planning);
  shell('git', ['merge-base', '--is-ancestor', approval.planningCommit, 'origin/main'], planning);
}
function terminateChild(state, signal = 'SIGTERM') {
  if (!groupAlive(state.pending?.childPid)) return;
  try {
    process.kill(-state.pending.childPid, signal);
  } catch {
    try {
      process.kill(state.pending.childPid, signal);
    } catch {
      // The child may have exited between the liveness check and the signal.
    }
  }
}
async function terminateAndConfirm(state) {
  if (!groupAlive(state.pending?.childPid)) return true;
  terminateChild(state);
  for (let attempt = 0; attempt < 10 && groupAlive(state.pending?.childPid); attempt++)
    await sleep(100);
  if (!groupAlive(state.pending?.childPid)) return true;
  terminateChild(state, 'SIGKILL');
  for (let attempt = 0; attempt < 20 && groupAlive(state.pending?.childPid); attempt++)
    await sleep(100);
  return !groupAlive(state.pending?.childPid);
}
async function holdUntilDead(state, reason) {
  state.status = 'blocked';
  state.stopReason = `${reason}: child termination unconfirmed`;
  save(state);
  while (groupAlive(state.pending?.childPid)) {
    terminateChild(state, 'SIGKILL');
    await sleep(1000);
  }
}
function supervisorAlive() {
  const pidFile = join(lockDir, 'pid');
  return existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8')));
}
function beforeLaunch(state) {
  const item = currentItem(state);
  if (state.phase !== 'review' && state.phase !== 'merge') return;
  const proof = state.items[item];
  if (!proof?.pr || !proof.headSha) fail('No published PR head for next session');
  const current = prEvidence(proof.pr);
  if (current.merged || current.headSha !== proof.headSha)
    fail('PR head changed before the next session');
  if (state.phase === 'merge') {
    if (proof.approval?.headSha !== current.headSha || !current.checksGreen)
      fail('Merge head lacks exact independent approval or green CI');
    const plan = publishedPlanning();
    if (plan.local !== plan.remote) fail('Review planning record changed before merge');
    shell(
      'git',
      ['merge-base', '--is-ancestor', proof.approval.planningCommit, plan.remote],
      planning
    );
    const approvedHandoff = shell(
      'git',
      ['show', `${proof.approval.planningCommit}:handoff/mbp.md`],
      planning
    );
    if (readFileSync(join(planning, 'handoff/mbp.md'), 'utf8').trim() !== approvedHandoff)
      fail('Mbp handoff changed after review approval');
  }
}
function lock() {
  ensureHome();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      writeFileSync(join(lockDir, 'pid'), String(process.pid), { mode: 0o600 });
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = existsSync(join(lockDir, 'pid'))
        ? Number(readFileSync(join(lockDir, 'pid'), 'utf8'))
        : null;
      if (alive(pid)) fail(`Another mbp supervisor is running (${pid})`);
      if (Date.now() - statSync(lockDir).mtimeMs < 10_000)
        fail('Another supervisor may be acquiring the lane lock');
      try {
        renameSync(lockDir, `${lockDir}.stale.${randomUUID()}`);
      } catch {
        /* another process won */
      }
    }
  }
  fail('Could not acquire mbp lane lock');
}
function unlock() {
  if (existsSync(lockDir)) rmSync(lockDir, { recursive: true });
}
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
function notifyTerminal() {
  let state;
  try {
    state = load();
    if (
      !Object.hasOwn(state, 'terminalNotice') ||
      state.terminalNotice !== null ||
      existsSync(ctl('stop')) ||
      !['blocked', 'complete'].includes(state.status)
    )
      return;
    state.terminalNotice = {
      attemptedAt: new Date().toISOString(),
      terminalStatus: state.status,
      commandExit: null,
      error: null,
    };
    save(state); // Persist before external delivery: a restart must not send a second push.
    const command = state.config.notifyCommand ?? 'claude-notify';
    const complete = state.status === 'complete';
    const reason = String(state.stopReason ?? state.status)
      .replaceAll(/\s+/g, ' ')
      .slice(0, 160);
    const message = complete
      ? `Run ${state.runId} is klaar. Bekijk de pilotstatus voor het resultaat.`
      : `Run ${state.runId} is geblokkeerd: ${reason}. Bekijk de pilotstatus en logs.`;
    const result = spawnSync(
      command,
      [`mycel · pilot ${complete ? 'klaar' : 'wacht'}`, message, ''],
      {
        encoding: 'utf8',
        timeout: 10_000,
        stdio: 'ignore',
        env: { ...process.env, CLAUDE_NOTIFY_BANNER_ONLY: complete ? '1' : '0' },
      }
    );
    state.terminalNotice.commandExit = result.status;
    state.terminalNotice.error =
      result.error?.code ?? (result.status === 0 ? null : 'nonzero-exit');
    save(state);
    if (state.terminalNotice.error)
      appendFileSync(
        join(home, `${state.runId}-notification.stderr.log`),
        `${state.terminalNotice.attemptedAt} terminal notification failed (${state.terminalNotice.error}, exit ${result.status ?? 'none'})\n`,
        { mode: 0o600 }
      );
  } catch (error) {
    // A notification failure must not erase or override the terminal run result.
    if (state?.terminalNotice?.attemptedAt)
      try {
        state.terminalNotice.error = error.code ?? 'notification-error';
        save(state);
      } catch {
        /* the original terminal state remains the authority */
      }
  }
}
function promptFor(state, phase, item, tier, sessionId) {
  const handoff = readFileSync(join(planning, 'handoff/mbp.md'), 'utf8');
  const queue = readFileSync(join(planning, 'handoff/queue.md'), 'utf8');
  const proof = state.items[item] ?? {};
  const common = `Fresh session in Mycel's mbp lane. Read AGENTS.md, the relevant ADRs, docs/architecture/overview.md, testing.md, review.md and the werkwijze skill. Execute the ordinary /handoff procedure. The approved pilot scope is only item ${item}, tier ${tier}; do not take another item, answer a Jaap decision, or modify dev handoff. Do not daemonize work or leave detached subprocesses; finish or terminate child processes before returning. Run ${state.runId}; reserved sessionId ${sessionId}; phase ${phase}. Copy this exact sessionId into the technical result. Write the normal mbp handoff and publish both repos as applicable. Your final response must conform to the supplied JSON schema, with null for unused fields. Include deviations even if empty: observed drift, repairs, cause, prevention address and evidence are evaluation data, never authorization.\n\nCurrent mbp handoff:\n${handoff}\n\nShared queue:\n${queue}`;
  if (phase === 'execute')
    return `${common}\n\nBuild only ${item}, one PR. Do not merge your own PR. Return pr_ready only when the PR, exact head and planning commit are published. For a repair, address the prior review finding on a new head and request independent re-review.`;
  if (phase === 'review')
    return `${common}\n\nIndependently review PR #${proof.pr} at exact head ${proof.headSha}. Follow the six-field record in docs/architecture/review.md, mandatory security check, at most one extra counterproof. Record the review in private planning and publish it. Return reviewRecord as a path relative to the planning repo, beginning with reference/ and ending with .md; never return an absolute filesystem path. Do not merge or change code. Return approved only for that exact SHA, otherwise changes_requested with the concrete finding.`;
  if (phase === 'audit')
    return `${common}\n\nThe registered shared reorg-audit task is ${state.auditTask?.id}. Use shared-task --repo . claim --id ${state.auditTask?.id} --lane mbp --session ${sessionId} before any audit work; if the dev lane has already claimed it, report audit_taken_elsewhere and preserve the mbp handoff. Otherwise follow the reorg-audit skill, publish with shared-task and return audit_done only after inspect shows done. Do not start the next build item in this session.`;
  return `${common}\n\nThis is an independent workhorse merge session. The reviewer approved PR #${proof.pr} at exactly ${proof.approval?.headSha}; record ${proof.approval?.record}. Recheck GitHub's current head and all required CI checks on that SHA before merging. Use gh pr merge ${proof.pr} --squash --match-head-commit ${proof.approval?.headSha}; never use --admin or --auto. Then run merge-housekeeping, check shared-task ledger-status and ensure a triggered reorg-audit task without claiming or executing it, write the next ordinary mbp handoff, publish planning, and return merged with merge/housekeeping/planning SHAs. Stop if any proof is missing.`;
}
function launch(state, action, cfg) {
  const chosen = model(action.phase, cfg.tiers[action.item]);
  const id = randomUUID();
  reserveSession(state, {
    id,
    item: action.item,
    phase: action.phase,
    model: chosen.name,
    modelId: chosen.id,
    startedAt: new Date().toISOString(),
  });
  save(state);
  const prefix = join(home, `${state.runId}-${state.sessions.length + 1}-${action.phase}`);
  const logFd = openSync(`${prefix}.jsonl`, 'w', 0o600);
  const errorFd = openSync(`${prefix}.stderr.log`, 'w', 0o600);
  const argv = [
    ...codexBaseArgs(chosen.id),
    '--output-schema',
    join(here, 'result.schema.json'),
    '-o',
    `${prefix}.result.json`,
    promptFor(state, action.phase, action.item, cfg.tiers[action.item], id),
  ];
  const child = spawn('codex', argv, {
    cwd: repo,
    detached: true,
    stdio: ['ignore', logFd, errorFd],
  });
  markLaunched(state, child.pid);
  state.pending.resultPath = `${prefix}.result.json`;
  state.pending.jsonlPath = `${prefix}.jsonl`;
  save(state);
  return child;
}
function threadId(path) {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((entry) => entry.includes('"thread.started"'));
  return line ? JSON.parse(line).thread_id : null;
}
async function daemon() {
  lock();
  try {
    while (true) {
      let state = load();
      if (existsSync(ctl('stop'))) {
        if (!(await terminateAndConfirm(state))) await holdUntilDead(state, 'operator-stop');
        stop(state);
        save(state);
        return;
      }
      if (['blocked', 'complete', 'stopped'].includes(state.status)) {
        if (!(await terminateAndConfirm(state))) await holdUntilDead(state, 'terminal-state');
        return;
      }
      const paused = existsSync(ctl('pause'));
      if (paused && state.status === 'active') {
        pause(state);
        save(state);
      } else if (!paused && state.status === 'paused') {
        resume(state);
        save(state);
      }
      if (Date.now() - Date.parse(state.startedAt) >= state.maxMinutes * 60_000) {
        if (!(await terminateAndConfirm(state))) await holdUntilDead(state, 'wall-clock-limit');
        state.status = 'blocked';
        state.stopReason = 'wall-clock-limit';
        save(state);
        return;
      }
      if (state.pending) {
        const pending = state.pending;
        if (pending.status === 'reserved') {
          state.status = 'blocked';
          state.stopReason = 'reserved-before-launch';
          save(state);
          return;
        }
        if (groupAlive(pending.childPid)) {
          await sleep(3000);
          continue;
        }
        const result =
          pending.resultPath && existsSync(pending.resultPath) ? json(pending.resultPath) : null;
        if (result) result.codexThreadId = threadId(pending.jsonlPath);
        try {
          reconcilePending(state, {
            childAlive: false,
            result,
            external: result ? externalFor(state, result) : null,
          });
        } catch (error) {
          state.status = 'blocked';
          state.stopReason = `invalid-handoff: ${error.message}`;
          state.events.push({
            kind: 'invalid-handoff',
            item: pending.item,
            phase: pending.phase,
            reason: error.message,
          });
        }
        save(state);
        if (state.status !== 'active') return;
        continue;
      }
      if (paused) return;
      let action = nextAction(state);
      if (action.kind === 'halt') {
        state.status = action.reason === 'allowlist-complete' ? 'complete' : 'blocked';
        state.stopReason = action.reason;
        save(state);
        return;
      }
      const cfg = state.config;
      try {
        beforeLaunch(state);
        launch(state, action, cfg);
      } catch (error) {
        state = load();
        if (!(await terminateAndConfirm(state))) await holdUntilDead(state, 'prelaunch');
        state.status = 'blocked';
        state.stopReason = `prelaunch: ${error.message}`;
        state.events.push({
          kind: 'prelaunch-block',
          item: action.item,
          phase: action.phase,
          reason: error.message,
        });
        save(state);
        return;
      }
    }
  } finally {
    try {
      notifyTerminal();
    } finally {
      unlock();
    }
  }
}
function dryRun(cfg) {
  const report = {
    lane: cfg.lane,
    allowlist: cfg.allowlist,
    maxSessions: cfg.maxSessions,
    maxRepairs: cfg.maxRepairs,
    maxMinutes: cfg.maxMinutes,
    codeHead: shell('git', ['rev-parse', 'HEAD']),
    planning: publishedPlanning(),
    selectedModels: {},
  };
  for (const item of cfg.allowlist)
    for (const phase of ['execute', 'review', 'merge', 'audit'])
      report.selectedModels[`${item}:${phase}`] = model(phase, cfg.tiers[item]);
  report.existingClaims = readFileSync(join(planning, 'TODO.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('|') && cfg.allowlist.some((item) => line.includes(item)));
  report.activePrs = jsonFromGhPrList();
  return report;
}
function jsonFromGhPrList() {
  return JSON.parse(
    shell('gh', [
      'pr',
      'list',
      '-R',
      'bolsterdigital/mycel',
      '--state',
      'open',
      '--json',
      'number,title,headRefName',
    ])
  );
}
function preflight(cfg) {
  const dry = dryRun(cfg);
  if (
    dry.existingClaims.length ||
    dry.activePrs.some((pr) => cfg.allowlist.some((item) => pr.title.includes(item)))
  )
    fail('Allowlisted item is already claimed or has an open PR');
  const tools = [
    'node',
    'git',
    'gh',
    'codex',
    'model-mode',
    'gtimeout',
    cfg.notifyCommand ?? 'claude-notify',
  ];
  const missing = tools.filter((name) => !toolExists(name));
  if (!existsSync(sharedTask)) missing.push(sharedTask);
  if (missing.length) fail(`Missing tools: ${missing.join(', ')}`);
  shell('codex', ['login', 'status']);
  shell('gh', ['auth', 'status']);
  const permissions = JSON.parse(shell('gh', ['api', 'repos/bolsterdigital/mycel'])).permissions;
  if (!permissions?.push) fail('GitHub push permission missing');
  if (dry.planning.local !== dry.planning.remote) fail('Planning main is not published');
  if (shell('git', ['status', '--porcelain'], planning)) fail('Planning has uncommitted changes');
  const gpgSign = optionalShell('git', ['config', '--bool', 'commit.gpgsign']) === 'true';
  let signing = 'DCO sign-off; cryptographic commit signing not configured';
  if (gpgSign) {
    const probe = spawnSync(
      'gtimeout',
      ['15', 'git', 'commit-tree', '-S', 'HEAD^{tree}', '-p', 'HEAD'],
      { cwd: repo, encoding: 'utf8' }
    );
    if (probe.status !== 0)
      fail(`Unattended signing probe failed (${probe.status ?? probe.signal})`);
    signing = 'Bounded real commit-tree signature succeeded without changing refs';
  }
  ensureHome();
  const probeSchema = ctl('probe.schema.json');
  writeFileSync(
    probeSchema,
    JSON.stringify({
      type: 'object',
      properties: { ready: { const: true } },
      required: ['ready'],
      additionalProperties: false,
    }),
    { mode: 0o600 }
  );
  for (const selected of new Map(
    Object.values(dry.selectedModels).map((entry) => [entry.id, entry])
  ).values()) {
    const probeResult = ctl(`probe-${selected.id}.json`);
    rmSync(probeResult, { force: true });
    const probe = spawnSync(
      'codex',
      [
        ...codexBaseArgs(selected.id),
        '--output-schema',
        probeSchema,
        '-o',
        probeResult,
        'Return {"ready":true}. Do not use tools or change files.',
      ],
      { cwd: repo, encoding: 'utf8', timeout: 90_000 }
    );
    if (
      probe.status !== 0 ||
      !probe.stdout.includes('"turn.completed"') ||
      !existsSync(probeResult) ||
      json(probeResult).ready !== true
    )
      fail(`Model access failed: ${selected.name}`);
  }
  const proof = {
    at: new Date().toISOString(),
    codeDigest: shaFiles(),
    codeHead: dry.codeHead,
    planningCommit: dry.planning.remote,
    signing,
    models: dry.selectedModels,
    githubPush: true,
  };
  ensureHome();
  writeFileSync(ctl('preflight.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  return proof;
}
function status() {
  const state = load();
  const elapsedMinutes = Math.round((Date.now() - Date.parse(state.startedAt)) / 60_000);
  const item = state.phase === 'audit' ? state.auditTask?.item : currentItem(state);
  const phase = state.pending?.phase ?? state.phase;
  return {
    runId: state.runId,
    lane: state.lane,
    status: ['blocked', 'complete', 'stopped'].includes(state.status)
      ? state.status
      : existsSync(ctl('stop'))
        ? 'stopping'
        : existsSync(ctl('pause'))
          ? state.status === 'paused'
            ? 'paused'
            : 'pausing'
          : state.status,
    item,
    phase,
    model: state.pending?.model ?? (item ? model(phase, state.config.tiers[item]).name : null),
    codexThreadId:
      state.pending?.jsonlPath && existsSync(state.pending.jsonlPath)
        ? threadId(state.pending.jsonlPath)
        : null,
    pr: state.items[item]?.pr ?? state.items[state.allowlist[state.index - 1]]?.pr ?? null,
    elapsedMinutes,
    sessions: state.sessions.length,
    deviations: state.deviations.length,
    next: nextAction(state),
    stopReason: state.stopReason,
    notification: state.terminalNotice?.attemptedAt
      ? {
          attemptedAt: state.terminalNotice.attemptedAt,
          status: state.terminalNotice.error
            ? 'failed'
            : state.terminalNotice.commandExit === 0
              ? 'invoked'
              : 'unconfirmed',
          error: state.terminalNotice.error,
        }
      : null,
  };
}

try {
  if (command === 'dry-run') console.log(JSON.stringify(dryRun(config(args[1])), null, 2));
  else if (command === 'preflight')
    console.log(JSON.stringify(preflight(config(args[1])), null, 2));
  else if (command === 'start') {
    if (existsSync(stateFile)) fail('State exists; use resume, or archive the old run explicitly');
    const cfg = config(args[1]);
    const currentClaims = dryRun(cfg);
    if (
      currentClaims.existingClaims.length ||
      currentClaims.activePrs.some((pr) => cfg.allowlist.some((item) => pr.title.includes(item)))
    )
      fail('An allowlisted item is already claimed or has an open PR');
    const proof = existsSync(ctl('preflight.json'))
      ? json(ctl('preflight.json'))
      : fail('Preflight missing');
    const approval = existsSync(ctl('activation.json'))
      ? json(ctl('activation.json'))
      : fail('Independent flagship activation record missing');
    verifyActivation(approval, proof);
    if (
      shell('git', ['branch', '--show-current']) !== 'main' ||
      shell('git', ['status', '--porcelain'])
    )
      fail('Start requires a clean main checkout');
    const state = newRun({ ...cfg, runId: runId() });
    state.config = { ...cfg, baselinePlanningCommit: publishedPlanning().remote };
    state.terminalNotice = null;
    ensureHome();
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(JSON.stringify({ runId: state.runId, supervisorPid: child.pid }));
  } else if (command === 'daemon') await daemon();
  else if (command === 'status') console.log(JSON.stringify(status(), null, 2));
  else if (command === 'pause') {
    const state = load();
    if (['complete', 'stopped', 'blocked'].includes(state.status))
      fail(`Cannot pause ${state.status} run`);
    ensureHome();
    writeFileSync(ctl('pause'), '1', { mode: 0o600 });
    if (!supervisorAlive()) {
      pause(state);
      save(state);
    } else {
      for (let attempt = 0; attempt < 300 && load().status !== 'paused'; attempt++)
        await sleep(100);
      if (load().status !== 'paused') fail('Supervisor did not acknowledge pause');
    }
    console.log('Paused; no new sessions will start');
  } else if (command === 'resume') {
    const state = load();
    if (['stopped', 'complete', 'blocked'].includes(state.status))
      fail(
        `Cannot resume ${state.status} run; inspect the saved proof and start a new bounded run`
      );
    rmSync(ctl('pause'), { force: true });
    if (supervisorAlive()) {
      console.log('Supervisor resumed');
      process.exit(0);
    }
    if (state.status === 'paused') resume(state);
    save(state);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log(`Supervisor resumed: ${child.pid}`);
  } else if (command === 'stop') {
    ensureHome();
    writeFileSync(ctl('stop'), '1', { mode: 0o600 });
    if (supervisorAlive()) {
      for (let attempt = 0; attempt < 300 && load().status !== 'stopped'; attempt++) {
        if (!supervisorAlive()) break;
        await sleep(100);
      }
    }
    if (load().status !== 'stopped' && !supervisorAlive()) {
      const state = load();
      if (state.pending?.status === 'reserved')
        fail('Supervisor exited with an unconfirmed launch; inspect processes and logs');
      if (!(await terminateAndConfirm(state))) {
        state.status = 'blocked';
        state.stopReason = 'operator-stop: child termination unconfirmed';
        save(state);
        fail('Agent process remains alive after stop');
      }
      stop(state);
      save(state);
    }
    if (load().status !== 'stopped') fail('Supervisor did not acknowledge stop');
    const stopped = load();
    for (let attempt = 0; attempt < 50 && groupAlive(stopped.pending?.childPid); attempt++)
      await sleep(100);
    if (groupAlive(stopped.pending?.childPid)) terminateChild(stopped, 'SIGKILL');
    if (groupAlive(stopped.pending?.childPid)) fail('Agent process group remains alive after stop');
    console.log('Stopped; active agent process group terminated');
  } else if (command === 'logs') {
    ensureHome();
    const files = readdirSync(home)
      .filter((name) => name.endsWith('.jsonl') || name.endsWith('.stderr.log'))
      .sort();
    if (args[1] === '--files') console.log(files.map((name) => join(home, name)).join('\n'));
    else
      for (const name of files.slice(-2))
        console.log(
          `== ${name} ==\n${readFileSync(join(home, name), 'utf8').split('\n').slice(-40).join('\n')}`
        );
  } else
    fail('Usage: cli.mjs dry-run|preflight|start <config.json>; status|logs|pause|resume|stop');
} catch (error) {
  console.error(`handoff-pilot: ${error.message}`);
  process.exitCode = 1;
}
