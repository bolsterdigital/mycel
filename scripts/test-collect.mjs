#!/usr/bin/env node
// Collect every Vitest suite with an empty environment and run none of them (testing.md rule 3:
// skip or fail, never crash). A suite that reads its database URL or config in the describe body
// throws while collecting, even under `describe.skipIf`, so a clean checkout without `.env` sees
// a red `verify` instead of skips. Only PATH and HOME survive, so no exported variable can hide
// such a body. Run by `npm run verify` before the real test run; collecting takes seconds.
// Rejected: `vitest list`, which swallows a collection error and exits 0, and a second full
// `vitest run` without env, which doubles the unit-test time to prove the same thing.

import { spawnSync } from 'node:child_process';

const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
const { status } = spawnSync('npx', ['vitest', 'run', '--testNamePattern', '^collect-only$'], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
process.exitCode = status ?? 1;
