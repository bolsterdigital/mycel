// A process-level fixture checks the supervisor boundary with fake external CLIs and isolated
// state, rather than giving the test real GitHub or Codex credentials.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { newRun, reserveSession, markLaunched } from './state.mjs';

const cli = resolve('tools/handoff-pilot/cli.mjs');
const timeout = 10_000;

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
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout });
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
result=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --approve-for-me) seen_approval=1;;
    --sandbox) exit 91;;
    -C) shift; [ "$1" = '${resolve('.')}' ] && seen_repo=1;;
    --add-dir) shift; [ "$1" = '${join(f.root, 'planning')}' ] && seen_planning=1;;
    --output-schema) shift; [ -f "$1" ] && seen_schema=1;;
    -o) shift; result="$1";;
  esac
  shift
done
[ "$seen_approval" -eq 1 ] && [ "$seen_repo" -eq 1 ] && [ "$seen_planning" -eq 1 ] && [ "$seen_schema" -eq 1 ] || exit 92
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
  assert.match(blocked.stopReason, /invalid-handoff: Missing prior planning commit/);
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
  state.config = { tiers: { '#44': 'workhorse' } };
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
