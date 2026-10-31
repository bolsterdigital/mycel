#!/usr/bin/env node
// `npm run dev`: builds the workspace packages the fronts import (they resolve to dist/), then
// runs the API (with the outbox worker in-process) and the SvelteKit dev server side by side
// with prefixed output. Stopping one stops both, so a crashed API never leaves a web server
// that renders pages whose form posts go nowhere.
//
// Operator login needs an IdP: when OIDC_ISSUER is unset or points at 127.0.0.1, this also starts
// scripts/e2e/mock-oidc.mjs (log in at /admin as admin@probe.test after `npm run db:seed`). Set
// OIDC_ISSUER to a real provider (Zitadel, see .env.example) to use that instead.
// Rejected: `concurrently` or `npm-run-all` (ADR 008 policy 1: forty lines of our own cover it).

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const build = spawnSync('npx', ['tsc', '-b', 'packages/api'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

// Read .env here too (shell variables win, as with --env-file), to see which IdP it names.
try {
  process.loadEnvFile(`${root}.env`);
} catch {}
const env = { ...process.env };
const issuer = env.OIDC_ISSUER;
const mockIdp = !issuer || new URL(issuer).hostname === '127.0.0.1';
if (mockIdp) {
  const port = issuer ? new URL(issuer).port || '80' : (env.MOCK_OIDC_PORT ?? '8799');
  Object.assign(env, {
    OIDC_ISSUER: `http://127.0.0.1:${port}`,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID ?? 'mycel-dev',
    MOCK_OIDC_PORT: port,
    MOCK_OIDC_USER: env.MOCK_OIDC_USER ?? 'admin@probe.test',
  });
  delete env.OIDC_CLIENT_SECRET;
}

const procs = [
  ['api', 'npm', ['run', '-s', 'dev', '-w', '@mycel/api']],
  // Arguments after `npm run dev --` go to Vite (`-- --port 5174 --strictPort`); they were dropped.
  ['web', 'npm', ['run', '-s', 'dev', '-w', '@mycel/web', '--', ...process.argv.slice(2)]],
  ...(mockIdp ? [['idp', 'node', ['scripts/e2e/mock-oidc.mjs']]] : []),
].map(([name, cmd, args]) => {
  // How a test run's preflight names this process's database sessions (TODO #27): stopping
  // this pid stops all of them.
  const PGAPPNAME = env.PGAPPNAME ?? `mycel npm run dev ${name}, pid ${process.pid}`;
  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...env, PGAPPNAME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, out] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let rest = '';
    stream.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
  }
  child.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    stop(code ?? 1);
  });
  return child;
});

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
  process.exitCode = code;
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
