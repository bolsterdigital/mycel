#!/usr/bin/env node
// `npm run dev`: builds the workspace packages the fronts import (they resolve to dist/), then
// runs the API (with the outbox worker in-process) and the SvelteKit dev server side by side
// with prefixed output. Stopping one stops both, so a crashed API never leaves a web server
// that renders pages whose form posts go nowhere.
// Rejected: `concurrently` or `npm-run-all` (ADR 008 policy 1: forty lines of our own cover it).

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const build = spawnSync('npx', ['tsc', '-b', 'packages/api'], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

const procs = [
  ['api', ['run', '-s', 'dev', '-w', '@mycel/api']],
  ['web', ['run', '-s', 'dev', '-w', '@mycel/web']],
].map(([name, args]) => {
  const child = spawn('npm', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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
