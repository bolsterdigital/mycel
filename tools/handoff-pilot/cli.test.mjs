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
  for (const [name, body] of Object.entries({
    git: '#!/bin/sh\ncase "$1" in rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; ls-remote) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main";; esac\n',
    gh: '#!/bin/sh\necho "[]"\n',
    'model-mode':
      '#!/bin/sh\nif [ "$1" = name-for ] && [ -n "$MYCEL_PILOT_BLOCK_MODEL_MARKER" ]; then touch "$MYCEL_PILOT_BLOCK_MODEL_MARKER"; while [ ! -e "$MYCEL_PILOT_BLOCK_MODEL_RELEASE" ]; do sleep 0.05; done; fi\ncase "$1" in name-for) echo Sol;; name) if [ "$2" = stuur ]; then echo Astra; else echo Sol; fi;; get) echo gpt-6-sol;; esac\n',
    codex: `#!/bin/sh\ntouch '${codexMarker}'\nif [ -n "$MYCEL_PILOT_FAKE_CODEX_SLEEP" ]; then sleep 30; fi\nexit 97\n`,
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
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, home, config, env, codexMarker };
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

test('preflight exercises the launch approval flags without a conflicting sandbox flag', (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.root, 'bin/gh'),
    '#!/bin/sh\nif [ "$1" = api ]; then echo \'{"permissions":{"push":true}}\'; else echo "[]"; fi\n',
    { mode: 0o755 }
  );
  writeFileSync(
    join(f.root, 'bin/codex'),
    `#!/bin/sh
if [ "$1" = login ]; then exit 0; fi
seen_approval=0
result=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --approve-for-me) seen_approval=1;;
    --sandbox) exit 91;;
    -o) shift; result="$1";;
  esac
  shift
done
[ "$seen_approval" -eq 1 ] || exit 92
printf '{"ready":true}' > "$result"
printf '{"type":"turn.completed"}\\n'
`,
    { mode: 0o755 }
  );
  const ran = call(f.env, 'preflight', f.config);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).models['#44:execute'].id, 'gpt-6-sol');
  assert.throws(() => readFileSync(join(f.home, 'state.json')));
});

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
