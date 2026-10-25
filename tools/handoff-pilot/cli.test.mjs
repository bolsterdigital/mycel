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
  mkdirSync(home);
  mkdirSync(planning);
  mkdirSync(join(planning, 'handoff'));
  mkdirSync(bin);
  writeFileSync(
    join(planning, 'TODO.md'),
    '# TODO\n\n## Claimbord\n\n| Item | Wie | Sinds |\n\n## Open werk\n\n### 44. Pilot item\n'
  );
  writeFileSync(join(planning, 'handoff/mbp.md'), '');
  const codexMarker = join(root, 'codex-called');
  for (const [name, body] of Object.entries({
    git: '#!/bin/sh\ncase "$1" in rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; ls-remote) echo "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main";; esac\n',
    gh: '#!/bin/sh\necho "[]"\n',
    'model-mode':
      '#!/bin/sh\ncase "$1" in name-for) echo Sol;; name) if [ "$2" = stuur ]; then echo Astra; else echo Sol; fi;; get) echo gpt-6-sol;; esac\n',
    codex: `#!/bin/sh\ntouch '${codexMarker}'\nexit 97\n`,
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

test('dry-run launches no agent and writes no run state', (t) => {
  const f = fixture(t);
  const ran = call(f.env, 'dry-run', f.config);
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(JSON.parse(ran.stdout).allowlist[0], '#44');
  assert.throws(() => readFileSync(f.codexMarker));
  assert.throws(() => readFileSync(join(f.home, 'state.json')));
});

test('a second supervisor is excluded; stop terminates the active agent group', async (t) => {
  const f = fixture(t);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
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
  await new Promise((done) => child.once('exit', done));
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
