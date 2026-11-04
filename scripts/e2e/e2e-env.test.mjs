// `npm run test:e2e` without a database says so and exits 1, never a green exit 0 without one
// browser test having run (TODO #175, testing.md rule 3). A real child process, because the exit
// code is the contract. Run by `npm run lint:infra`, offline: the run stops before any browser,
// database or build is needed.
// Rejected: a text check for `process.exit(1)`, which would pass a script that skips before it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../lib/repo.mjs';

const run = (extra) =>
  spawnSync(process.execPath, [join(ROOT, 'scripts/e2e/e2e.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...extra },
  });

test('without DATABASE_URL the run fails and names it', () => {
  const { status, stderr, stdout } = run({ MYCEL_NO_DOTENV: '1' });
  assert.equal(status, 1, stdout);
  assert.match(stderr, /DATABASE_URL is not set: this gate needs a database and did not run/);
});

test('E2E_REQUIRED no longer decides it: the same failure without CI and with it', () => {
  const inCi = run({ MYCEL_NO_DOTENV: '1', E2E_REQUIRED: '1' });
  assert.equal(inCi.status, 1, inCi.stdout);
  assert.match(inCi.stderr, /DATABASE_URL is not set/);
});
