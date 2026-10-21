#!/usr/bin/env node
// Runs the Playwright + axe gate (ADR 009 rule 3) when its infrastructure exists: a Postgres
// (DATABASE_URL + APP_DATABASE_URL) and an installed Chromium. Without them it prints why it
// skipped and exits 0, so `verify` stays usable on a laptop without a database; CI sets
// E2E_REQUIRED=1 so a missing service fails the build instead of skipping silently.
// Rejected: a separate CI-only command, which lets the gate drift out of `verify`.
//
// The signup flow needs more than the web app: the outbox worker sends the confirmation mail,
// and the spec reads that mail from a spool directory and checks the supporter over HTTP. So
// this script also starts the API process (worker in-process, console mailer with
// MAIL_SPOOL_DIR) on its own port and stops it afterwards. Rejected: a second webServer entry
// in playwright.config.ts, which cannot create the spool directory or share its path.
//
// The admin flow (TODO #7) logs in through scripts/mock-oidc.mjs, which this script starts too,
// and uses an API key: generated here before the seed, which stores its hash for tenant probe.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const required = process.env.E2E_REQUIRED === '1';
const skip = (why) => {
  if (required) {
    console.error(`e2e: required but ${why}`);
    process.exit(1);
  }
  console.log(`e2e: skipped (${why}); set DATABASE_URL and APP_DATABASE_URL to run it`);
  process.exit(0);
};

for (const name of [
  'DATABASE_URL',
  'APP_DATABASE_URL',
  'AUTH_DATABASE_URL',
  'SIGNING_SECRET',
  'PUBLIC_BASE_URL',
  'MAIL_FROM',
])
  if (!process.env[name]) skip(`${name} is not set`);

const { chromium } = await import('@playwright/test');
if (!existsSync(chromium.executablePath()))
  skip('Chromium is not installed (npx playwright install chromium)');
if (!existsSync(`${root}apps/web/build/index.js`)) skip('apps/web is not built (npm run build)');
if (!existsSync(`${root}packages/api/dist/server.js`)) skip('packages/api is not built');

const run = (cmd, args, cwd = root, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
// The seed stores this token's hash as the `seed` key of tenant probe; API and spec use it.
const apiKey = process.env.MYCEL_API_KEY ?? `mycel_${randomBytes(32).toString('base64url')}`;
run('npm', ['run', '-s', 'migrate', '-w', '@mycel/db']);
run('npm', ['run', '-s', 'seed', '-w', '@mycel/db'], root, {
  ...process.env,
  MYCEL_API_KEY: apiKey,
});

// The web app under test listens on 4173 (playwright.config.ts); links in the mail must point
// there, so the API process gets the same origin regardless of what .env says.
const WEB_ORIGIN = 'http://127.0.0.1:4173';
const API_PORT = process.env.E2E_API_PORT ?? '8797';
const OIDC_PORT = process.env.E2E_OIDC_PORT ?? '8798';
const spool = mkdtempSync(join(tmpdir(), 'mycel-e2e-mail-'));
const env = {
  ...process.env,
  PUBLIC_BASE_URL: WEB_ORIGIN,
  MAILER: 'console',
  MAIL_SPOOL_DIR: spool,
  MYCEL_API_KEY: apiKey,
  OIDC_ISSUER: `http://127.0.0.1:${OIDC_PORT}`,
  OIDC_CLIENT_ID: 'mycel-e2e',
  E2E_API_URL: `http://127.0.0.1:${API_PORT}`,
};
// The mock is a public client; a secret from .env would make the token request differ.
delete env.OIDC_CLIENT_SECRET;

const idp = spawn('node', ['scripts/mock-oidc.mjs'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...env, MOCK_OIDC_PORT: OIDC_PORT },
});
const api = spawn('node', ['packages/api/dist/server.js'], {
  cwd: root,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...env, PORT: API_PORT },
});
const stop = () => {
  if (api.exitCode === null) api.kill('SIGTERM');
  if (idp.exitCode === null) idp.kill('SIGTERM');
  rmSync(spool, { recursive: true, force: true });
};
process.on('exit', stop);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(1));

async function waitFor(name, child, url) {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (child.exitCode !== null) {
      console.error(`e2e: ${name} exited with ${child.exitCode}`);
      process.exit(1);
    }
    const ok = await fetch(url)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    if (Date.now() > deadline) {
      console.error(`e2e: ${name} did not become healthy in 30s`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
await waitFor('API process', api, `${env.E2E_API_URL}/healthz`);
await waitFor('mock IdP', idp, `${env.OIDC_ISSUER}/.well-known/openid-configuration`);

// The children keep the event loop alive; stop them explicitly once the tests are done.
run('npx', ['playwright', 'test'], `${root}apps/web`, env);
stop();
process.exit(0);
