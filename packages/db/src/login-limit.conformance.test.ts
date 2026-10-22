// The login rate limit against Postgres (TODO #20b, migration 0018): what the in-memory store
// cannot prove. Two identity stores on two pools of the authentication login stand in for two
// web processes behind Caddy; they must count into one window, and the janitor must sweep old
// windows and never a live one.
//
// Skips without DATABASE_URL and AUTH_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { FakeClock } from '@mycel/core/testing';
import { createDb, createIdentityStore, sweepRateLimits, uuidv7Ids } from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const authUrl = process.env['AUTH_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !authUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or AUTH_DATABASE_URL is unset');

describe.skipIf(!operatorUrl || !authUrl)('shared login limit', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const poolA = createDb(authUrl ?? '');
  const poolB = createDb(authUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const limit = { max: 20, windowSeconds: 600 };
  // A fixed window boundary, so the test cannot straddle two windows.
  const clock = new FakeClock(new Date(Math.floor(Date.now() / 600_000) * 600_000 + 1_000));
  const a = createIdentityStore(poolA, uuidv7Ids, clock);
  const b = createIdentityStore(poolB, uuidv7Ids, clock);
  const key = (k: string) => `login-${run}-${k}`.padEnd(22, 'x');

  /** The windows of `k`, read as mycel_auth (the owner sees nothing under forced RLS). */
  const windows = (k: string) =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_auth`.execute(trx);
      return trx
        .selectFrom('login_attempts')
        .select(['window_start', 'hits'])
        .where('key', '=', key(k))
        .orderBy('window_start')
        .execute();
    });

  afterAll(async () => {
    await Promise.all([operatorDb.destroy(), poolA.destroy(), poolB.destroy()]);
  });

  it('counts one window across two pools: the 21st attempt fails on either', async () => {
    // Interleaved and concurrent: the upsert is one statement, so no hit is lost.
    const results = await Promise.all(
      Array.from({ length: limit.max }, (_, i) => (i % 2 ? a : b).loginAttempt(key('x'), limit))
    );
    expect(results.every(Boolean)).toBe(true);
    expect(await a.loginAttempt(key('x'), limit)).toBe(false);
    expect(await b.loginAttempt(key('x'), limit)).toBe(false);
    expect((await windows('x')).map((w) => w.hits)).toEqual([limit.max + 2]);
    // Another address has its own count.
    expect(await b.loginAttempt(key('y'), limit)).toBe(true);
  });

  it('starts a new window at one', async () => {
    clock.advance(limit.windowSeconds * 1000);
    expect(await a.loginAttempt(key('x'), limit)).toBe(true);
    expect((await windows('x')).map((w) => w.hits)).toEqual([limit.max + 2, 1]);
  });

  it('lets the janitor sweep windows older than a day, and no younger one', async () => {
    const old = createIdentityStore(
      poolA,
      uuidv7Ids,
      new FakeClock(new Date(Date.now() - 2 * 86_400_000))
    );
    expect(await old.loginAttempt(key('old'), limit)).toBe(true);
    expect(await windows('old')).toHaveLength(1);
    expect(await sweepRateLimits(operatorDb)).toBeGreaterThanOrEqual(1);
    expect(await windows('old')).toEqual([]);
    expect(await windows('x')).toHaveLength(2);
    // Whatever its query asks, the janitor's policies reach no live window.
    const deleted = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_janitor`.execute(trx);
      return trx.deleteFrom('login_attempts').where('key', '=', key('x')).executeTakeFirst();
    });
    expect(deleted.numDeletedRows).toBe(0n);
  });
});
