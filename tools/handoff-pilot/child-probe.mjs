#!/usr/bin/env node
// Exercise the four permissions a real pilot child needs. Rejected: a no-tools model reply,
// which only proves model access and says nothing about Git, loopback, Postgres or dependencies.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const planning = resolve(process.env.MYCEL_PILOT_PLANNING ?? resolve(repo, '../mycel-planning'));
const requireDb = createRequire(new URL('../../packages/db/package.json', import.meta.url));

function command(file, args, cwd) {
  const run = spawnSync(file, args, { cwd, timeout: 15_000, stdio: 'ignore' });
  return { ok: run.status === 0, exitCode: run.status ?? -1 };
}

async function loopback() {
  const server = createServer();
  try {
    const port = await new Promise((resolvePort, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolvePort(server.address().port));
    });
    return { ok: true, port };
  } catch {
    return { ok: false, port: 0 };
  } finally {
    if (server.listening) await new Promise((done) => server.close(done));
  }
}

async function database() {
  if (!process.env.APP_DATABASE_URL) return { ok: false, value: null };
  let client;
  try {
    const { Client } = requireDb('pg');
    client = new Client({
      connectionString: process.env.APP_DATABASE_URL,
      connectionTimeoutMillis: 5000,
    });
    await client.connect();
    const result = await client.query('select 1 as value');
    return { ok: result.rows[0]?.value === 1, value: result.rows[0]?.value ?? null };
  } catch {
    return { ok: false, value: null };
  } finally {
    if (client) await client.end().catch(() => {});
  }
}

const result = {
  git: command('git', ['-C', planning, 'update-index', '--refresh'], repo),
  loopback: await loopback(),
  database: await database(),
  dependencies: command('npm', ['ls', '--depth=0'], repo),
};
console.log(JSON.stringify(result));
