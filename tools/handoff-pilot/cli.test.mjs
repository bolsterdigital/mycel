// A process-level fixture checks the supervisor boundary with fake external CLIs and isolated
// state, rather than giving the test real GitHub or Codex credentials.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { newRun as createRun, reserveSession as reserve, markLaunched } from './state.mjs';

const scopesFor = (items) =>
  Object.fromEntries(items.map((item) => [item, { paths: [], directories: ['apps/web/'] }]));
function newRun(config, now) {
  const state = createRun({ scopes: scopesFor(config.allowlist), ...config }, now);
  // Synthetic daemon fixtures still pin the real executable bytes.
  state.config = { runnerDigest: runnerDigest() };
  return state;
}
function reserveSession(state, session) {
  return reserve(state, { codeBase: 'e'.repeat(40), ...session });
}

const cli = resolve('tools/handoff-pilot/cli.mjs');
const timeout = 10_000;
function runnerDigest() {
  const hash = createHash('sha256');
  for (const name of ['cli.mjs', 'child-probe.mjs', 'state.mjs', 'result.schema.json'])
    hash.update(readFileSync(resolve('tools/handoff-pilot', name)));
  return hash.digest('hex');
}

test('review proof accepts a published relative path and rejects an absolute path', () => {
  const schema = JSON.parse(readFileSync(resolve('tools/handoff-pilot/result.schema.json')));
  const pattern = new RegExp(schema.properties.reviewRecord.pattern);
  assert.ok(pattern.test('reference/review-pr62-2026-10-25.md'));
  assert.ok(!pattern.test('/Users/jstronks/mycel-planning/reference/review-pr62-2026-10-25.md'));
  assert.ok(!pattern.test('../reference/review-pr62-2026-10-25.md'));
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mycel-pilot-test-'));
  const home = join(root, 'home');
  const planning = join(root, 'planning');
  const bin = join(root, 'bin');
  const sharedTask = join(root, '.claude/bin/shared-task');
  mkdirSync(home);
  mkdirSync(planning);
  mkdirSync(join(planning, 'handoff'));
  mkdirSync(bin);
  mkdirSync(join(root, '.claude/bin'), { recursive: true });
  writeFileSync(sharedTask, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'gtimeout'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(
    join(planning, 'TODO.md'),
    '# TODO\n\n## Claimbord\n\n| Item | Wie | Sinds |\n\n## Open werk\n\n### 44. Pilot item\n'
  );
  writeFileSync(join(planning, 'handoff/mbp.md'), '');
  writeFileSync(join(planning, 'handoff/queue.md'), '');
  const codexMarker = join(root, 'codex-called');
  const notifyMarker = join(root, 'notify-called');
  for (const [name, body] of Object.entries({
    git: '#!/bin/sh\ncase "$1" in rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; ls-remote) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main";; esac\n',
    gh: '#!/bin/sh\necho "[]"\n',
    'model-mode':
      '#!/bin/sh\nif [ "$1" = name-for ] && [ -n "$MYCEL_PILOT_BLOCK_MODEL_MARKER" ]; then touch "$MYCEL_PILOT_BLOCK_MODEL_MARKER"; while [ ! -e "$MYCEL_PILOT_BLOCK_MODEL_RELEASE" ]; do sleep 0.05; done; fi\ncase "$1" in name-for) echo Sol;; name) if [ "$2" = stuur ]; then echo Astra; else echo Sol; fi;; get) echo gpt-6-sol;; esac\n',
    codex: `#!/bin/sh\ntouch '${codexMarker}'\nif [ -n "$MYCEL_PILOT_FAKE_CODEX_SLEEP" ]; then sleep 30; fi\nexit 97\n`,
    'claude-notify':
      '#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$CLAUDE_NOTIFY_BANNER_ONLY" "$1" "$2" "$3" >> "$MYCEL_PILOT_NOTIFY_MARKER"\nexit "${MYCEL_PILOT_NOTIFY_EXIT:-0}"\n',
  })) {
    const path = join(bin, name);
    writeFileSync(path, body, { mode: 0o755 });
  }
  const config = join(root, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      repo: 'bolsterdigital/mycel',
      planning,
      lane: 'mbp',
      allowlist: ['#44'],
      scopes: scopesFor(['#44']),
      tiers: { '#44': 'workhorse' },
      maxSessions: 8,
      maxRepairs: 2,
      maxMinutes: 360,
    })
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    MYCEL_PILOT_HOME: home,
    MYCEL_PILOT_PLANNING: planning,
    MYCEL_PILOT_NOTIFY_MARKER: notifyMarker,
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, config, env, codexMarker, notifyMarker };
}
function call(env, ...args) {
  return spawnSync(process.execPath, [env.MYCEL_TEST_CLI ?? cli, ...args], {
    env,
    encoding: 'utf8',
    timeout,
  });
}
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}
async function waitForFile(path) {
  for (let tries = 0; tries < 100; tries++) {
    if (spawnSync('test', ['-e', path]).status === 0) return;
    await sleep(50);
  }
  assert.fail(`Timed out waiting for ${path}`);
}

test('dry-run launches no agent and writes no run state', (t) => {
  const f = fixture(t);
  const ran = call(f.env, 'dry-run', f.config);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).allowlist[0], '#44');
  assert.throws(() => readFileSync(f.codexMarker));
  assert.throws(() => readFileSync(join(f.home, 'state.json')));
});

function fakePreflightCodex(f) {
  writeFileSync(
    join(f.root, 'bin/codex'),
    `#!/bin/sh
if [ "$1" = login ]; then exit 0; fi
seen_approval=0
seen_repo=0
seen_planning=0
seen_schema=0
seen_approval_prompt=0
result=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --approve-for-me) seen_approval=1;;
    --sandbox) exit 91;;
    -C) shift; [ "$1" = '${resolve('.')}' ] && seen_repo=1;;
    --add-dir) shift; [ "$1" = '${join(f.root, 'planning')}' ] && seen_planning=1;;
    --output-schema) shift; [ -f "$1" ] && seen_schema=1;;
    -o) shift; result="$1";;
    *"ordinary on-request approval route"*"If approval is rejected"*) seen_approval_prompt=1;;
  esac
  shift
done
[ "$seen_approval" -eq 1 ] && [ "$seen_repo" -eq 1 ] && [ "$seen_planning" -eq 1 ] && [ "$seen_schema" -eq 1 ] && [ "$seen_approval_prompt" -eq 1 ] || exit 92
printf '%s' "$MYCEL_PILOT_FAKE_PROBE_RESULT" > "$result"
printf '{"type":"turn.completed"}\\n'
`,
    { mode: 0o755 }
  );
}

const passingProbe = {
  git: { ok: true, exitCode: 0 },
  loopback: { ok: true, port: 54321 },
  database: { ok: true, value: 1 },
  dependencies: { ok: true, exitCode: 0 },
};

test('preflight exercises the launch flags and accepts all four child axes', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, 'bin/gh'),
    '#!/bin/sh\nif [ "$1" = api ]; then echo \'{"permissions":{"push":true}}\'; else echo "[]"; fi\n',
    { mode: 0o755 }
  );
  fakePreflightCodex(f);
  const ran = call(
    { ...f.env, MYCEL_PILOT_FAKE_PROBE_RESULT: JSON.stringify(passingProbe) },
    'preflight',
    f.config
  );
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).models['#44:execute'].id, 'gpt-6-sol');
  assert.ok(readFileSync(join(f.home, 'preflight.json'), 'utf8').includes('codeDigest'));
  assert.throws(() => readFileSync(join(f.home, 'state.json')));
});

for (const axis of Object.keys(passingProbe)) {
  test(`preflight rejects a failed ${axis} child axis without writing proof`, (t) => {
    const f = fixture(t);
    writeFileSync(
      join(f.root, 'bin/gh'),
      '#!/bin/sh\nif [ "$1" = api ]; then echo \'{"permissions":{"push":true}}\'; else echo "[]"; fi\n',
      { mode: 0o755 }
    );
    fakePreflightCodex(f);
    writeFileSync(join(f.home, 'preflight.json'), '{"stale":true}\n');
    const evidence = structuredClone(passingProbe);
    evidence[axis].ok = false;
    const ran = call(
      { ...f.env, MYCEL_PILOT_FAKE_PROBE_RESULT: JSON.stringify(evidence) },
      'preflight',
      f.config
    );
    assert.equal(ran.status, 1);
    assert.match(ran.stderr, new RegExp(`Child preflight ${axis} failed`));
    assert.throws(() => readFileSync(join(f.home, 'preflight.json')));
  });
}

test('a second supervisor is excluded; stop terminates the active agent group', async (t) => {
  const f = fixture(t);
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    {
      detached: true,
      stdio: 'ignore',
    }
  );
  const childExit = new Promise((done) => child.once('exit', done));
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  });
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  reserveSession(state, {
    id: 'reserved',
    item: '#44',
    phase: 'execute',
    model: 'Sol',
    startedAt: new Date().toISOString(),
  });
  markLaunched(state, child.pid);
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  const supervisor = spawn(process.execPath, [cli, 'daemon'], { env: f.env, stdio: 'ignore' });
  t.after(() => {
    try {
      supervisor.kill('SIGKILL');
    } catch {
      /* already stopped */
    }
  });
  for (let tries = 0; tries < 30; tries++) {
    if (spawnSync('test', ['-e', join(f.home, 'mbp.lock')]).status === 0) break;
    await sleep(50);
  }
  const duplicate = call(f.env, 'daemon');
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /Another mbp supervisor/);
  const stopped = call(f.env, 'stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  await childExit;
  assert.equal(JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).status, 'stopped');
  assert.throws(() => readFileSync(f.codexMarker));
});

test('daemon recovers an interrupted reservation by blocking, never relaunching', (t) => {
  const f = fixture(t);
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  reserveSession(state, {
    id: 'reserved',
    item: '#44',
    phase: 'execute',
    model: 'Sol',
    startedAt: new Date().toISOString(),
  });
  markLaunched(state, 99999999);
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  const ran = call(f.env, 'daemon');
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(
    JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).stopReason,
    'interrupted-without-proof'
  );
  assert.throws(() => readFileSync(f.codexMarker));
});

test('invalid handoff exits the supervisor once and preserves the blocked reservation', (t) => {
  const f = fixture(t);
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  state.terminalNotice = null;
  reserveSession(state, {
    id: 'reviewed',
    item: '#44',
    phase: 'execute',
    model: 'Sol',
    startedAt: new Date().toISOString(),
  });
  markLaunched(state, 99999999);
  state.pending.resultPath = join(f.home, 'invalid-result.json');
  state.pending.jsonlPath = join(f.home, 'reviewed.jsonl');
  writeFileSync(state.pending.resultPath, JSON.stringify({ pr: 60, outcome: 'pr_ready' }));
  writeFileSync(state.pending.jsonlPath, '{"type":"thread.started","thread_id":"fresh"}\n');
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));

  const first = call(f.env, 'daemon');
  assert.equal(first.status, 0, first.stderr);
  const blocked = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.stopReason, /invalid-handoff: scope: .*Missing scope base or head/);
  assert.equal(blocked.pending.id, 'reviewed');
  assert.equal(blocked.events.filter((entry) => entry.kind === 'invalid-handoff').length, 1);
  assert.equal(blocked.terminalNotice.terminalStatus, 'blocked');
  assert.equal(blocked.terminalNotice.commandExit, 0);
  assert.equal(readFileSync(f.notifyMarker, 'utf8').trim().split('\n').length, 1);
  assert.match(readFileSync(f.notifyMarker, 'utf8'), /^0\|mycel · pilot wacht\|/);
  assert.throws(() => readFileSync(join(f.home, 'mbp.lock/pid')));

  const restarted = call(f.env, 'daemon');
  assert.equal(restarted.status, 0, restarted.stderr);
  const afterRestart = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  assert.deepEqual(afterRestart, blocked);
  assert.equal(readFileSync(f.notifyMarker, 'utf8').trim().split('\n').length, 1);
  const resumed = call(f.env, 'resume');
  assert.equal(resumed.status, 1);
  assert.match(resumed.stderr, /Cannot resume blocked run/);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')), blocked);
  assert.throws(() => readFileSync(f.codexMarker));
});

test('completion uses a local banner once and pause sends nothing', (t) => {
  const f = fixture(t);
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  state.terminalNotice = null;
  state.status = 'paused';
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  writeFileSync(join(f.home, 'pause'), '1');
  assert.equal(call(f.env, 'daemon').status, 0);
  assert.throws(() => readFileSync(f.notifyMarker));
  rmSync(join(f.home, 'pause'));
  state.status = 'active';
  state.index = 1;
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  assert.equal(call(f.env, 'daemon').status, 0);
  const completed = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  assert.equal(completed.status, 'complete');
  assert.equal(completed.terminalNotice.commandExit, 0);
  assert.match(readFileSync(f.notifyMarker, 'utf8'), /^1\|mycel · pilot klaar\|/);
  assert.equal(call(f.env, 'daemon').status, 0);
  assert.equal(readFileSync(f.notifyMarker, 'utf8').trim().split('\n').length, 1);
});

test('notification failure stays visible without retry or changing a blocked reason', (t) => {
  const f = fixture(t);
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = {
    tiers: { '#44': 'workhorse' },
    notifyCommand: join(f.root, 'missing-notifier'),
  };
  state.terminalNotice = null;
  state.status = 'blocked';
  state.stopReason = 'missing-authority';
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  const failed = call(f.env, 'daemon');
  assert.equal(failed.status, 0, failed.stderr);
  const report = JSON.parse(call(f.env, 'status').stdout);
  assert.equal(report.status, 'blocked');
  assert.equal(report.stopReason, 'missing-authority');
  assert.equal(report.notification?.status, 'failed');
  assert.equal(report.notification?.error, 'ENOENT');
  assert.match(readFileSync(join(f.home, 'fixture-notification.stderr.log'), 'utf8'), /failed/);
  assert.equal(call(f.env, 'daemon').status, 0);
  assert.equal(
    readFileSync(join(f.home, 'fixture-notification.stderr.log'), 'utf8').trim().split('\n').length,
    1
  );
  assert.throws(() => readFileSync(f.notifyMarker));
});

test('changed PR head blocks review before a new agent is launched', (t) => {
  const f = fixture(t);
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  state.phase = 'review';
  state.items['#44'] = { pr: 60, headSha: 'a'.repeat(40), authorSession: 'earlier' };
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  const ran = call(f.env, 'daemon');
  assert.equal(ran.status, 0, ran.stderr);
  const after = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  assert.equal(after.status, 'blocked');
  assert.match(after.stopReason, /PR head changed/);
  assert.throws(() => readFileSync(f.codexMarker));
});

test('stop during model selection acknowledges only after any late child is gone', async (t) => {
  const f = fixture(t);
  const marker = join(f.root, 'model-blocked');
  const release = join(f.root, 'model-release');
  const env = {
    ...f.env,
    MYCEL_PILOT_BLOCK_MODEL_MARKER: marker,
    MYCEL_PILOT_BLOCK_MODEL_RELEASE: release,
    MYCEL_PILOT_FAKE_CODEX_SLEEP: '1',
  };
  const state = newRun({
    runId: 'fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 8,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  const daemon = spawn(process.execPath, [cli, 'daemon'], { env, stdio: 'ignore' });
  t.after(() => daemon.kill('SIGKILL'));
  await waitForFile(marker);
  const stopped = spawn(process.execPath, [cli, 'stop'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const completion = new Promise((done) => stopped.once('exit', done));
  const chunks = [];
  stopped.stderr.on('data', (chunk) => chunks.push(chunk));
  await sleep(100);
  writeFileSync(release, 'go');
  const exitCode = await completion;
  assert.equal(exitCode, 0, Buffer.concat(chunks).toString());
  const after = JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8'));
  assert.equal(after.status, 'stopped');
  if (after.pending?.childPid) assert.throws(() => process.kill(after.pending.childPid, 0));
});

test('pause keeps enforcing the wall-clock deadline for a running child', async (t) => {
  const f = fixture(t);
  const descendantMarker = join(f.root, 'descendant.pid');
  const leaderCode = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(descendantMarker)}, String(child.pid)); process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', leaderCode], {
    detached: true,
    stdio: 'ignore',
  });
  const childExit = new Promise((done) => child.once('exit', done));
  t.after(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  });
  await waitForFile(descendantMarker);
  const descendantPid = Number(readFileSync(descendantMarker, 'utf8'));
  const state = newRun(
    {
      runId: 'fixture',
      lane: 'mbp',
      allowlist: ['#44'],
      maxSessions: 8,
      maxRepairs: 2,
      maxMinutes: 1,
    },
    new Date(Date.now() - 55_000).toISOString()
  );
  state.config = { runnerDigest: runnerDigest(), tiers: { '#44': 'workhorse' } };
  reserveSession(state, {
    id: 'running',
    item: '#44',
    phase: 'execute',
    model: 'Sol',
    startedAt: new Date().toISOString(),
  });
  markLaunched(state, child.pid);
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
  const daemon = spawn(process.execPath, [cli, 'daemon'], { env: f.env, stdio: 'ignore' });
  t.after(() => daemon.kill('SIGKILL'));
  await waitForFile(join(f.home, 'mbp.lock'));
  const paused = call(f.env, 'pause');
  assert.equal(paused.status, 0, paused.stderr);
  for (let tries = 0; tries < 100; tries++) {
    if (
      JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).stopReason === 'wall-clock-limit'
    )
      break;
    await sleep(50);
  }
  assert.equal(
    JSON.parse(readFileSync(join(f.home, 'state.json'), 'utf8')).stopReason,
    'wall-clock-limit'
  );
  await childExit;
  assert.equal(spawnSync('test', ['-e', join(f.home, 'mbp.lock')]).status, 1);
  const descendant = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(descendantPid)], {
    encoding: 'utf8',
  });
  assert.ok(descendant.status !== 0 || descendant.stdout.trim().startsWith('Z'));
});

// Real local Git history is the counterexample: fake Git output would merely restate the
// checker, and could not prove rename parsing or distinguish concurrent main commits.
function scopeFixture(
  t,
  edit,
  { concurrent = false, phase = 'execute', repair = false, scope, files = {} } = {}
) {
  const f = fixture(t);
  const code = join(f.root, 'code');
  const origin = join(f.root, 'origin.git');
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  function git(...args) {
    const ran = spawnSync(realGit, args, { cwd: code, encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    return ran.stdout.trim();
  }
  mkdirSync(join(code, 'tools/handoff-pilot'), { recursive: true });
  mkdirSync(join(code, 'apps/web'), { recursive: true });
  mkdirSync(join(code, 'scripts'));
  for (const name of ['cli.mjs', 'state.mjs', 'child-probe.mjs', 'result.schema.json'])
    copyFileSync(resolve('tools/handoff-pilot', name), join(code, 'tools/handoff-pilot', name));
  writeFileSync(join(code, 'apps/web/allowed.txt'), 'original\n');
  writeFileSync(join(code, 'scripts/e2e.mjs'), 'original script\n');
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(code, path, '..'), { recursive: true });
    writeFileSync(join(code, path), contents);
  }
  git('init', '-b', 'main');
  git('config', 'user.name', 'Pilot Fixture');
  git('config', 'user.email', 'pilot@probe.test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  git('init', '--bare', origin);
  git('remote', 'add', 'origin', origin);
  git('add', '.');
  git('commit', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  git('push', 'origin', 'main');
  git('switch', '-c', 'item');
  edit({ code, git });
  git('add', '.');
  git('commit', '--allow-empty', '-m', 'item result');
  let main = base;
  if (concurrent) {
    git('switch', 'main');
    writeFileSync(join(code, 'scripts/independent-dev.mjs'), 'independent main change\n');
    git('add', '.');
    git('commit', '-m', 'independent dev work');
    main = git('rev-parse', 'HEAD');
    git('push', 'origin', 'main');
    git('switch', 'item');
    git('merge', '--no-edit', 'main');
  }
  const head = git('rev-parse', 'HEAD');
  git('push', 'origin', 'HEAD:refs/pull/60/head');
  // Planning and GitHub are external services; only those answers are synthetic.
  const plan = 'b'.repeat(40);
  writeFileSync(
    join(f.root, 'bin/git'),
    `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.MYCEL_TEST_UNREADABLE_DIFF && args[0] === 'diff') process.exit(71);
if (process.cwd() === require('node:fs').realpathSync(${JSON.stringify(join(f.root, 'planning'))})) {
  if (args[0] === 'rev-parse') console.log('${plan}');
  if (args[0] === 'ls-remote') console.log('${plan} refs/heads/main');
  if (args[0] === 'diff') console.log('handoff/mbp.md');
} else {
  const r = spawnSync(${JSON.stringify(realGit)}, args, {stdio:'inherit'});
  process.exit(r.status ?? 1);
}
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(f.root, 'bin/gh'),
    `#!${process.execPath}
console.log(JSON.stringify({number:60,headRefOid:'${head}',mergedAt:null,
statusCheckRollup:['verify','security','image','compose'].map(name=>({name,conclusion:'SUCCESS'}))}));
`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(f.root, '.claude/bin/shared-task'),
    '#!/bin/sh\necho \'{"threshold_met":false}\'\n',
    { mode: 0o755 }
  );
  writeFileSync(join(f.root, 'planning/handoff/mbp.md'), `stuur\n# review #60 ${head} workhorse\n`);
  const state = newRun({
    ...(scope ? { scopes: { '#44': scope } } : {}),
    runId: 'scope-fixture',
    lane: 'mbp',
    allowlist: ['#44'],
    maxSessions: 1,
    maxRepairs: 2,
    maxMinutes: 360,
  });
  state.config = {
    tiers: { '#44': 'workhorse' },
    runnerDigest: runnerDigest(),
    baselinePlanningCommit: plan,
  };
  state.items['#44'] = {
    scopeBase: base,
    worktrees: git('worktree', 'list', '--porcelain', '-z')
      .split('\0')
      .filter((field) => field.startsWith('worktree '))
      .sort(),
  };
  if (phase === 'execute') {
    reserveSession(state, {
      id: 'scope-child',
      item: '#44',
      phase,
      codeBase: repair ? main : base,
      model: 'Sol',
      startedAt: new Date().toISOString(),
    });
    markLaunched(state, 99999999);
    state.pending.resultPath = join(f.home, 'result.json');
    state.pending.jsonlPath = join(f.home, 'child.jsonl');
    writeFileSync(
      state.pending.resultPath,
      JSON.stringify({
        runId: state.runId,
        lane: 'mbp',
        item: '#44',
        phase,
        sessionId: 'scope-child',
        outcome: 'pr_ready',
        pr: 60,
        headSha: head,
        planningCommit: plan,
        deviations: [],
        finishedAt: new Date().toISOString(),
      })
    );
    writeFileSync(
      state.pending.jsonlPath,
      '{"type":"thread.started","thread_id":"scope-thread"}\n'
    );
  } else {
    state.phase = phase;
    Object.assign(state.items['#44'], {
      pr: 60,
      headSha: head,
      authorSession: 'other',
      approval: { headSha: head, planningCommit: plan },
    });
  }
  function finish() {
    writeFileSync(join(f.home, 'state.json'), JSON.stringify(state));
    const ran = call(
      { ...f.env, MYCEL_TEST_CLI: join(code, 'tools/handoff-pilot/cli.mjs') },
      'daemon'
    );
    assert.equal(ran.status, 0, ran.stderr);
    assert.throws(() => readFileSync(f.codexMarker), 'No next child may launch');
    const after = JSON.parse(readFileSync(join(f.home, 'state.json')));
    const proofs = spawnSync('ls', [f.home], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter((name) => name.includes('-scope-') && name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(f.home, name))));
    return { after, proofs };
  }
  return { ...f, code, git, state, base, main, head, finish };
}

for (const [name, edit, path] of [
  [
    'green CI with dev script',
    ({ code }) => writeFileSync(join(code, 'scripts/e2e.mjs'), 'forbidden\n'),
    'scripts/e2e.mjs',
  ],
  [
    'rename out of scope',
    ({ git }) => git('mv', 'apps/web/allowed.txt', 'scripts/moved.txt'),
    'scripts/moved.txt',
  ],
  [
    'rename into scope',
    ({ git }) => git('mv', 'scripts/e2e.mjs', 'apps/web/moved.txt'),
    'scripts/e2e.mjs',
  ],
  ['delete out of scope', ({ git }) => git('rm', 'scripts/e2e.mjs'), 'scripts/e2e.mjs'],
  [
    'newline path out of scope',
    ({ code }) => writeFileSync(join(code, 'scripts/bad\nname.mjs'), 'forbidden'),
    'scripts/bad\nname.mjs',
  ],
]) {
  test(`scope rejects ${name} and preserves result/diff without another launch`, (t) => {
    const f = scopeFixture(t, edit);
    const { after, proofs } = f.finish();
    assert.equal(after.status, 'blocked');
    assert.equal(after.phase, 'execute');
    assert.equal(after.pending.id, 'scope-child');
    assert.equal(after.repairs['#44'], undefined);
    assert.match(after.stopReason, /Forbidden path/);
    assert.ok(after.stopReason.includes(JSON.stringify(path)));
    assert.ok(proofs[0].changes.some((change) => change.paths.includes(path)));
    assert.equal(proofs[0].base, f.base);
    assert.equal(proofs[0].head, f.head);
    assert.ok(readFileSync(join(f.home, 'result.json')));
    assert.equal(f.git('rev-parse', 'HEAD'), f.head);
  });
}

for (const kind of ['untracked', 'unstaged', 'staged']) {
  test(`scope rejects ${kind} worktree evidence after a valid PR`, (t) => {
    const f = scopeFixture(t, ({ code }) =>
      writeFileSync(join(code, 'apps/web/allowed.txt'), 'valid\n')
    );
    const path = kind === 'untracked' ? 'scripts/new.mjs' : 'scripts/e2e.mjs';
    writeFileSync(join(f.code, path), 'forbidden local write\n');
    if (kind === 'staged') f.git('add', path);
    const { after, proofs } = f.finish();
    assert.match(after.stopReason, /Forbidden path/);
    assert.ok(proofs[0].worktree.some((change) => change.paths.includes(path)));
    assert.equal(readFileSync(join(f.code, path), 'utf8'), 'forbidden local write\n');
  });
}

test('valid mbp diff excludes independent later main work, including during repair', (t) => {
  const f = scopeFixture(
    t,
    ({ code }) => writeFileSync(join(code, 'apps/web/allowed.txt'), 'valid\n'),
    { concurrent: true, repair: true }
  );
  const { after, proofs } = f.finish();
  assert.equal(after.phase, 'review', after.stopReason);
  assert.equal(after.stopReason, 'session-limit');
  assert.equal(after.items['#44'].scopeBase, f.base);
  assert.equal(proofs[0].diffBase, f.main);
  assert.equal(proofs[0].reason, null);
  assert.deepEqual(
    proofs[0].changes.flatMap((change) => change.paths),
    ['apps/web/allowed.txt']
  );
});

test('repair does not reset the cumulative item diff to its newer reservation', (t) => {
  const f = scopeFixture(
    t,
    ({ code }) => writeFileSync(join(code, 'scripts/e2e.mjs'), 'earlier forbidden write\n'),
    { concurrent: true, repair: true }
  );
  const { after, proofs } = f.finish();
  assert.match(after.stopReason, /Forbidden path/);
  assert.equal(proofs[0].base, f.base);
  assert.equal(after.pending.codeBase, f.main);
});

for (const phase of ['review', 'merge']) {
  test(`scope is rechecked on the pinned head before ${phase}`, (t) => {
    const f = scopeFixture(
      t,
      ({ code }) => writeFileSync(join(code, 'scripts/e2e.mjs'), 'forbidden\n'),
      { phase }
    );
    const { after } = f.finish();
    assert.match(after.stopReason, /prelaunch: scope: .*Forbidden path/);
    assert.equal(after.sessions.length, 0);
  });
}

for (const kind of [
  'changed-remote-head',
  'changed-base',
  'unreadable-diff',
  'unexpected-worktree',
]) {
  test(`scope fails closed for ${kind}`, (t) => {
    const f = scopeFixture(t, ({ code }) =>
      writeFileSync(join(code, 'apps/web/allowed.txt'), 'valid\n')
    );
    if (kind === 'changed-remote-head')
      f.git('push', 'origin', `${f.base}:refs/pull/60/head`, '--force');
    if (kind === 'changed-base') f.state.items['#44'].scopeBase = f.head;
    if (kind === 'unreadable-diff') f.env.MYCEL_TEST_UNREADABLE_DIFF = '1';
    if (kind === 'unexpected-worktree')
      f.git('worktree', 'add', '--detach', join(f.root, 'unexpected'), f.base);
    const { after, proofs } = f.finish();
    assert.equal(after.phase, 'execute');
    assert.equal(after.status, 'blocked');
    assert.match(after.stopReason, /scope:/);
    assert.ok(proofs[0].reason);
  });
}

test('missing or malformed scopes fail every new-run entry before external work', (t) => {
  const f = fixture(t);
  for (const scopes of [undefined, {}, { '#44': { paths: ['scripts/*'], directories: [] } }]) {
    const cfg = JSON.parse(readFileSync(f.config));
    cfg.scopes = scopes;
    writeFileSync(f.config, JSON.stringify(cfg));
    for (const entry of ['dry-run', 'preflight', 'start']) {
      const ran = call(f.env, entry, f.config);
      assert.equal(ran.status, 1);
      assert.match(ran.stderr, /scope/);
    }
  }
  assert.throws(() => readFileSync(f.codexMarker));
  assert.throws(() => readFileSync(join(f.home, 'state.json')));
});

test('product child cannot admit runner authority through its result', (t) => {
  const f = scopeFixture(t, ({ code }) =>
    writeFileSync(join(code, 'tools/handoff-pilot/result.schema.json'), '{}\n')
  );
  const { after, proofs } = f.finish();
  assert.match(after.stopReason, /Forbidden path/);
  assert.ok(
    proofs[0].changes.some((change) =>
      change.paths.includes('tools/handoff-pilot/result.schema.json')
    )
  );
});

test('terminal legacy state stays readable and cannot resume without a migration', (t) => {
  const f = fixture(t);
  const legacy = {
    schema: 1,
    runId: 'old',
    status: 'stopped',
    stopReason: 'operator-stop',
    lane: 'mbp',
    phase: 'execute',
    index: 0,
    allowlist: ['#44'],
    sessions: [],
    config: { tiers: { '#44': 'workhorse' } },
    deviations: [],
    items: {},
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(f.home, 'state.json'), JSON.stringify(legacy));
  assert.equal(call(f.env, 'status').status, 0);
  assert.equal(call(f.env, 'resume').status, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(f.home, 'state.json'))), legacy);
});

const siteRoute = 'apps/web/src/routes/(admin)/admin/[tenant]/site/+page.server.ts';
const siteDirectory = 'apps/web/src/routes/(admin)/admin/[tenant]/site/';
const sitemapRoute = 'apps/web/src/routes/(public)/[tenant]/sitemap.xml/+server.ts';
for (const [name, path, scope, allowed] of [
  ['exact site', siteRoute, { paths: [siteRoute], directories: [] }, true],
  ['exact sitemap', sitemapRoute, { paths: [sitemapRoute], directories: [] }, true],
  [
    'nested site',
    `${siteDirectory}nested/+page.ts`,
    { paths: [], directories: [siteDirectory] },
    true,
  ],
  [
    'different parameter',
    siteRoute.replace('[tenant]', '[site]'),
    { paths: [siteRoute], directories: [] },
    false,
  ],
  [
    'brackets are not a character class',
    siteRoute.replace('[tenant]', 't'),
    { paths: [siteRoute], directories: [] },
    false,
  ],
  [
    'parentheses are not grouping',
    siteRoute.replace('(admin)', 'admin'),
    { paths: [siteRoute], directories: [] },
    false,
  ],
  [
    'sibling site',
    siteRoute.replace('/site/', '/site-extra/'),
    { paths: [], directories: [siteDirectory] },
    false,
  ],
  [
    'dev status',
    siteRoute.replace('/site/', '/status/'),
    { paths: [], directories: [siteDirectory] },
    false,
  ],
  [
    'authority inside site',
    `${siteDirectory}AGENTS.md`,
    { paths: [], directories: [siteDirectory] },
    false,
  ],
]) {
  test(`real Git route scope: ${name}`, (t) => {
    const f = scopeFixture(
      t,
      ({ code }) => {
        mkdirSync(join(code, path, '..'), { recursive: true });
        writeFileSync(join(code, path), 'route addition\n');
      },
      { scope }
    );
    const { after, proofs } = f.finish();
    assert.equal(after.phase, allowed ? 'review' : 'execute', after.stopReason);
    if (allowed) assert.equal(proofs[0].reason, null);
    else assert.ok(proofs[0].reason.startsWith(`Forbidden path ${JSON.stringify(path)} (`));
    assert.ok(proofs[0].changes.some((change) => change.paths.includes(path)));
    if (!allowed) assert.equal(after.status, 'blocked');
  });
}
for (const kind of ['rename-out', 'rename-in', 'delete', 'untracked', 'repair']) {
  test(`real Git route scope preserves ${kind} boundary`, (t) => {
    const forbidden = siteRoute.replace('/site/', '/status/');
    const scope = { paths: [], directories: [siteDirectory] };
    const f = scopeFixture(
      t,
      ({ code, git }) => {
        if (kind === 'rename-out') {
          mkdirSync(join(code, forbidden, '..'), { recursive: true });
          git('mv', siteRoute, forbidden);
        } else if (kind === 'rename-in') {
          mkdirSync(join(code, siteRoute, '..'), { recursive: true });
          git('mv', forbidden, siteRoute);
        } else if (kind === 'delete') git('rm', forbidden);
        else writeFileSync(join(code, kind === 'repair' ? forbidden : siteRoute), 'changed\n');
      },
      {
        scope,
        files:
          kind === 'rename-out'
            ? { [siteRoute]: 'same\n' }
            : kind === 'rename-in'
              ? { [forbidden]: 'same\n' }
              : { [siteRoute]: 'same\n', [forbidden]: 'same\n' },
        repair: kind === 'repair',
        concurrent: kind === 'repair',
      }
    );
    if (kind === 'untracked') writeFileSync(join(f.code, forbidden + '.new'), 'outside\n');
    const { after, proofs } = f.finish();
    assert.equal(after.status, 'blocked');
    assert.equal(after.phase, 'execute');
    assert.match(after.stopReason, /Forbidden path/);
    assert.equal(proofs[0].base, f.base);
    assert.equal(after.repairs['#44'], undefined);
    if (kind.startsWith('rename'))
      assert.ok(
        proofs[0].changes.some(
          (change) =>
            change.status === 'R100' &&
            change.paths.includes(siteRoute) &&
            change.paths.includes(forbidden)
        )
      );
  });
}

test('bounded route dry-run retains the complete config digest without activating', (t) => {
  const f = fixture(t);
  const config = JSON.parse(readFileSync(f.config));
  config.scopes = {
    '#44': {
      paths: [
        sitemapRoute,
        'apps/web/src/routes/(public)/[tenant]/robots.txt/+server.ts',
        'apps/web/src/routes/(public)/[tenant]/[[locale=locale]]/[...path]/+page.svelte',
        'apps/web/src/routes/(public)/[tenant]/[[locale=locale]]/[...path]/+page.server.ts',
        'apps/web/src/routes/(preview)/admin/[tenant]/preview/item/[itemId]/+page.server.ts',
        'apps/web/src/routes/(preview)/admin/[tenant]/preview/draft/+page.server.ts',
        'apps/web/src/routes/(preview)/admin/[tenant]/preview/[...path]/+server.ts',
      ],
      directories: [siteDirectory],
    },
  };
  writeFileSync(f.config, JSON.stringify(config));
  const ran = call(f.env, 'dry-run', f.config);
  assert.equal(ran.status, 0, ran.stderr);
  const output = JSON.parse(ran.stdout);
  assert.deepEqual(output.scopes, config.scopes);
  assert.equal(
    output.configDigest,
    createHash('sha256').update(JSON.stringify(config)).digest('hex')
  );
  assert.throws(() => readFileSync(join(f.home, 'state.json')));
  assert.throws(() => readFileSync(f.codexMarker));
});

const publicDirectory = 'apps/web/src/routes/(public)/[tenant]/[[locale=locale]]/[...path]/';
const publicRoute = `${publicDirectory}+page.svelte`;
for (const [name, path, scope, allowed] of [
  ['public exact', publicRoute, { paths: [publicRoute], directories: [] }, true],
  [
    'public prefix',
    `${publicDirectory}+page.server.ts`,
    { paths: [], directories: [publicDirectory] },
    true,
  ],
  [
    'preview rest',
    'apps/web/src/routes/(preview)/admin/[tenant]/preview/[...path]/+server.ts',
    {
      paths: ['apps/web/src/routes/(preview)/admin/[tenant]/preview/[...path]/+server.ts'],
      directories: [],
    },
    true,
  ],
  [
    'optional is literal',
    publicRoute.replace('[[locale=locale]]', 'nl'),
    { paths: [], directories: [publicDirectory] },
    false,
  ],
  [
    'matcher is literal',
    publicRoute.replace('locale=locale', 'locale=other'),
    { paths: [publicRoute], directories: [] },
    false,
  ],
  [
    'rest is literal',
    publicRoute.replace('[...path]', 'nested/path'),
    { paths: [], directories: [publicDirectory] },
    false,
  ],
  [
    'public sibling',
    publicRoute.replace('[...path]', '[...other]'),
    { paths: [], directories: [publicDirectory] },
    false,
  ],
  [
    'public authority',
    `${publicDirectory}CLAUDE.md`,
    { paths: [], directories: [publicDirectory] },
    false,
  ],
]) {
  test(`real Git public route scope: ${name}`, (t) => {
    const f = scopeFixture(
      t,
      ({ code }) => {
        mkdirSync(join(code, path, '..'), { recursive: true });
        writeFileSync(join(code, path), 'literal route addition\n');
      },
      { scope }
    );
    const { after, proofs } = f.finish();
    assert.equal(after.phase, allowed ? 'review' : 'execute', after.stopReason);
    assert.ok(proofs[0].changes.some((change) => change.paths.includes(path)));
    if (allowed) assert.equal(proofs[0].reason, null);
    else {
      assert.equal(after.status, 'blocked');
      assert.match(after.stopReason, /Forbidden path/);
    }
  });
}

function blockedFixture(t, edit = () => {}) {
  const f = scopeFixture(t, edit);
  const proof = {
    runId: f.state.runId,
    sessionId: f.state.pending.id,
    item: '#44',
    lane: 'mbp',
    phase: 'execute',
    outcome: 'blocked',
    pr: null,
    headSha: null,
    reviewedHeadSha: null,
    planningCommit: 'b'.repeat(40),
    reviewRecord: null,
    mergeCommit: null,
    housekeepingCommit: null,
    finding: 'Required env inventory is outside scope',
    finishedAt: new Date().toISOString(),
    deviations: [
      {
        expected: 'Stay within scope',
        observed: 'Env dependency outside scope',
        detection: 'env conformance',
        repair: 'Stop',
        cause: 'Missing dependency',
        preventionAddress: '#45',
        evidence: 'reference/product-block.md',
      },
    ],
  };
  writeFileSync(f.state.pending.resultPath, JSON.stringify(proof));
  writeFileSync(
    join(f.root, 'planning/handoff/mbp.md'),
    'uitvoer\n# Blocked: dependency needs scope preparation\n'
  );
  // A no-PR result must not consult GitHub, even if GitHub would return a PR.
  writeFileSync(
    join(f.root, 'bin/gh'),
    `#!/bin/sh\necho queried > '${join(f.root, 'gh-called')}'\nexit 72\n`,
    { mode: 0o755 }
  );
  return { ...f, proof };
}
test('schema-conform blocked without PR preserves the product cause and stops without PR queries', (t) => {
  const f = blockedFixture(t);
  // R8 removed its incomplete product work and returned to clean main.
  f.git('switch', 'main');
  const schema = JSON.parse(readFileSync(resolve('tools/handoff-pilot/result.schema.json')));
  assert.deepEqual(Object.keys(f.proof).sort(), schema.required.slice().sort());
  const { after, proofs } = f.finish();
  assert.equal(after.status, 'blocked');
  assert.equal(after.stopReason, f.proof.finding);
  assert.equal(after.pending, null);
  assert.equal(after.sessions[0].finding, f.proof.finding);
  assert.equal(after.deviations[0].observed, f.proof.deviations[0].observed);
  assert.equal(after.index, 0);
  assert.equal(after.items['#44'].pr, undefined);
  assert.equal(proofs[0].head, f.base);
  assert.equal(proofs[0].reason, null);
  assert.throws(() => readFileSync(join(f.root, 'gh-called')));
});
for (const kind of [
  'identity',
  'planning',
  'handoff',
  'dev handoff',
  'unpublished planning',
  'committed',
  'staged',
  'unstaged',
  'untracked',
]) {
  test(`blocked without PR fails closed for invalid ${kind}`, (t) => {
    const f = blockedFixture(
      t,
      kind === 'committed'
        ? ({ code }) => writeFileSync(join(code, 'scripts/e2e.mjs'), 'forbidden\n')
        : undefined
    );
    if (kind === 'identity') f.proof.sessionId = 'wrong';
    if (kind === 'unpublished planning') {
      const path = join(f.root, 'bin/git');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          "if (args[0] === 'ls-remote') console.log('" + 'b'.repeat(40),
          "if (args[0] === 'ls-remote') console.log('" + 'f'.repeat(40)
        )
      );
    }
    if (kind === 'planning') f.proof.planningCommit = 'f'.repeat(40);
    if (kind === 'handoff') writeFileSync(join(f.root, 'planning/handoff/mbp.md'), '');
    if (kind === 'dev handoff') {
      const path = join(f.root, 'bin/git');
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace(
          "console.log('handoff/mbp.md')",
          "console.log('handoff/mbp.md\\nhandoff/dev.md')"
        )
      );
    }
    if (['staged', 'unstaged', 'untracked'].includes(kind)) {
      writeFileSync(
        join(f.code, kind === 'untracked' ? 'scripts/new.mjs' : 'scripts/e2e.mjs'),
        'forbidden\n'
      );
      if (kind === 'staged') f.git('add', '.');
    }
    writeFileSync(f.state.pending.resultPath, JSON.stringify(f.proof));
    const { after } = f.finish();
    assert.equal(after.status, 'blocked');
    assert.match(after.stopReason, /invalid-handoff:/);
    assert.equal(after.pending.id, 'scope-child');
    assert.equal(after.deviations.length, 0);
    assert.equal(after.index, 0);
    assert.throws(() => readFileSync(join(f.root, 'gh-called')));
  });
}
