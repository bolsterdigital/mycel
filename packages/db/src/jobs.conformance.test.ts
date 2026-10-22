// The jobs queue against Postgres (TODO #15, migration 0009): what the in-memory scheduler
// cannot prove. A job is planned in the use case's transaction and only then; mycel_app may
// insert under its own tenant and do nothing else; claims are leases taken with SKIP LOCKED, so
// two workers never share a job and a dead worker's job comes back after five minutes; a
// recurring job exists once per period however many workers plan it; the partition job refuses
// a filled `events_default` with a recovery step that works; the sweep runs as the janitor; an
// exhausted job stays findable.
//
// Every job here has a type or key of its own (`run`), and claims are narrowed to those types,
// so the suite never takes real work and runs beside the other database suites. Skips without
// DATABASE_URL and APP_DATABASE_URL; with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pg from 'pg';
import { Invoker, buildRegistry, systemPrincipal, useCases, type JobRecord } from '@mycel/core';
import { FakeDns, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  JOB_LEASE_SECONDS,
  claimJobs,
  completeJob,
  createDb,
  createEventPartitions,
  createUnitOfWork,
  ensureRecurring,
  failJob,
  migrate,
  runJobs,
  sweepRateLimits,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
  withTenant,
} from './index.js';
import { toJobRecord } from './jobs.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

const PLATFORM = 'conformance.test';

describe.skipIf(!operatorUrl || !appUrl)('jobs conformance', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const run = Math.random().toString(36).slice(2, 8);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    dns: new FakeDns(),
    platform: { ...memoryPlatform, domain: PLATFORM },
  });
  const invoker = new Invoker(buildRegistry(), uow);
  /** A job type no handler and no other suite knows. */
  const type = (name: string) => `conformance.${run}.${name}`;
  let tenantId = '';
  const admin = () => systemPrincipal(tenantId, 'test');

  const sqlState = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { code?: string }) => e.code
    );
  /** Every row with this key, read as the worker would. */
  const byKey = async (key: string): Promise<JobRecord[]> =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      const rows = await trx
        .selectFrom('jobs')
        .selectAll()
        .where('key', '=', key)
        .orderBy('id')
        .execute();
      return rows.map((r) => toJobRecord(r as Parameters<typeof toJobRecord>[0]));
    });
  /** Insert a due platform job as the worker. */
  async function due(t: string, key = `${t}:${uuidv7()}`, maxAttempts = 10): Promise<string> {
    await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      await trx
        .insertInto('jobs')
        .values({
          id: uuidv7(),
          tenant_id: null,
          type: t,
          key,
          run_at: new Date(Date.now() - 1000),
          payload: '{}',
          max_attempts: maxAttempts,
        })
        .execute();
    });
    return key;
  }

  beforeAll(async () => {
    await migrate(operatorUrl!, {
      appPassword: process.env['MYCEL_APP_PASSWORD'],
      authPassword: process.env['MYCEL_AUTH_PASSWORD'],
      log: () => {},
    });
    tenantId = (
      await upsertTenant(
        operatorDb,
        { id: uuidv7(), slug: `jobs-${run}`, name: 'Jobs', defaultLocale: 'nl', locales: ['nl'] },
        { platformDomain: PLATFORM }
      )
    ).id;
  });

  afterAll(async () => {
    // Close what this suite left open, so a worker on the same database (the e2e run) does not
    // pick it up as work without a handler.
    await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      await sql`update jobs set done_at = now()
                where done_at is null and type like ${`conformance.${run}.%`}`.execute(trx);
    });
    await Promise.all([operatorDb.destroy(), appDb.destroy()]);
  });

  it('plans a job in the use case transaction: committed once, rolled back never', async () => {
    const hostname = `www-${run}.example.org`;
    await invoker.run(useCases.addHostname, admin(), { hostname });
    await invoker.run(useCases.verifyHostname, admin(), { hostname });
    const planned = await byKey(`hostnames.reverify:${tenantId}:${hostname}`);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      tenantId,
      type: 'hostnames.reverify',
      payload: { hostname },
      attempts: 0,
      doneAt: null,
    });
    expect(planned[0]!.runAt.getTime() - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000);

    const key = `${type('rollback')}:x`;
    await expect(
      uow.run(admin(), async (ctx) => {
        await ctx.jobs.enqueue({
          type: 'hostnames.reverify',
          key,
          runAt: new Date(),
          payload: { hostname },
        });
        throw new Error('use case failed');
      })
    ).rejects.toThrow('use case failed');
    expect(await byKey(key)).toEqual([]);
  });

  it('keeps one open job per key, and a finished job does not block the next', async () => {
    const t = type('open');
    const key = `${t}:x`;
    const plan = () =>
      uow.run(admin(), (ctx) =>
        // A type of this suite's own, so the claim below never takes real work.
        ctx.jobs.enqueue({
          type: t as 'hostnames.reverify',
          key,
          runAt: new Date(Date.now() - 1000),
          payload: { hostname: 'x' },
        })
      );
    expect(await plan()).toBe(true);
    expect(await plan()).toBe(false);
    const [claimed] = await claimJobs(operatorDb, { types: [t] });
    expect(claimed).toMatchObject({ key, tenantId });
    expect(await completeJob(operatorDb, claimed!)).toBe(true);
    expect(await plan()).toBe(true);
    const rows = await byKey(key);
    expect(rows.map((r) => r.doneAt === null)).toEqual([false, true]);
  });

  it('lets mycel_app insert under its own tenant and nothing else', async () => {
    const asApp = (q: (trx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>) =>
      sqlState(withTenant(appDb, admin(), q));
    const row = (tenant: string | null) => ({
      id: uuidv7(),
      tenant_id: tenant,
      type: type('app'),
      key: `${type('app')}:${uuidv7()}`,
      run_at: new Date(),
      payload: '{}',
    });
    expect(await asApp((trx) => trx.insertInto('jobs').values(row(tenantId)).execute())).toBe('ok');
    // Not readable, not changeable, no platform job and no job for another tenant.
    expect(await asApp((trx) => trx.selectFrom('jobs').select('id').execute())).toBe('42501');
    expect(await asApp((trx) => trx.updateTable('jobs').set({ attempts: 0 }).execute())).toBe(
      '42501'
    );
    expect(await asApp((trx) => trx.insertInto('jobs').values(row(null)).execute())).toBe('42501');
    expect(await asApp((trx) => trx.insertInto('jobs').values(row(uuidv7())).execute())).toBe(
      '42501'
    );
  });

  it('splits a batch between two concurrent claims without overlap', async () => {
    const t = type('split');
    for (let i = 0; i < 5; i++) await due(t);
    const [a, b] = await Promise.all([
      claimJobs(operatorDb, { types: [t], batchSize: 3 }),
      claimJobs(operatorDb, { types: [t], batchSize: 3 }),
    ]);
    const ids = [...a!, ...b!].map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(5);
    expect([...a!, ...b!].every((j) => j.attempts === 1 && j.claimedAt !== null)).toBe(true);
    // Leased: nothing left to claim.
    expect(await claimJobs(operatorDb, { types: [t] })).toEqual([]);
  });

  it('frees the job of a dead worker after the lease, and the late worker cannot complete it', async () => {
    const t = type('lease');
    const key = await due(t);
    const [first] = await claimJobs(operatorDb, { types: [t] });
    expect(await claimJobs(operatorDb, { types: [t] })).toEqual([]);
    // The worker died: its lease runs out.
    await sql`update jobs set claimed_at = now() - make_interval(secs => ${JOB_LEASE_SECONDS + 1})
              where key = ${key}`.execute(operatorDb);
    const [second] = await claimJobs(operatorDb, { types: [t] });
    expect(second).toMatchObject({ id: first!.id, attempts: 2 });
    expect(await completeJob(operatorDb, first!)).toBe(false);
    expect(await completeJob(operatorDb, second!)).toBe(true);
    expect((await byKey(key))[0]!.doneAt).not.toBeNull();
  });

  it('plans the next run in the transaction that completes this one', async () => {
    const t = type('next');
    const key = await due(t);
    const [job] = await claimJobs(operatorDb, { types: [t] });
    const next = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await completeJob(operatorDb, job!, { next });
    const rows = await byKey(key);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ type: t, tenantId: null, runAt: next, doneAt: null });
  });

  it('backs off a failure, and leaves an exhausted job findable with its error', async () => {
    const t = type('fail');
    const key = await due(t, undefined, 2);
    const result = await runJobs(operatorDb, {}, { types: [t] });
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    let [row] = await byKey(key);
    expect(row).toMatchObject({ attempts: 1, claimedAt: null, lastError: `no handler for ${t}` });
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());

    await sql`update jobs set run_at = now() - interval '1 second' where key = ${key}`.execute(
      operatorDb
    );
    await runJobs(
      operatorDb,
      {
        [t]: async () => {
          throw new Error('still broken');
        },
      },
      { types: [t] }
    );
    await sql`update jobs set run_at = now() - interval '1 second' where key = ${key}`.execute(
      operatorDb
    );
    expect(await claimJobs(operatorDb, { types: [t] })).toEqual([]);
    // What TODO #17 will show and reset.
    const exhausted = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return (
        await sql<{ key: string; last_error: string }>`
          select key, last_error from jobs
          where done_at is null and attempts >= max_attempts and type = ${t}`.execute(trx)
      ).rows;
    });
    expect(exhausted).toEqual([{ key, last_error: 'still broken' }]);
  });

  it('plans each period of a recurring job once, however many workers plan it', async () => {
    const hourly = { type: type('hourly'), cadence: 'hourly' as const };
    const monthly = { type: type('monthly'), cadence: 'monthly' as const };
    const now = new Date('2031-01-31T10:30:00Z');
    const counts = await Promise.all(
      [1, 2, 3].map(() => ensureRecurring(operatorDb, [hourly, monthly], now))
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
    const [h] = await byKey(`${hourly.type}:2031-01-31T11`);
    const [m] = await byKey(`${monthly.type}:2031-02`);
    expect(h).toMatchObject({ runAt: new Date('2031-01-31T11:00:00Z'), tenantId: null });
    expect(m).toMatchObject({ runAt: new Date('2031-02-01T00:00:00Z'), tenantId: null });
    // The next tick in the same hour plans nothing new.
    expect(await ensureRecurring(operatorDb, [hourly, monthly], now)).toBe(0);
  });

  describe('events.partitions', () => {
    const created = ['2098_12', '2099_01', '2099_02', '2099_03'];

    afterAll(async () => {
      for (const m of created)
        await sql.raw(`drop table if exists events_${m}`).execute(operatorDb);
    });

    it('creates the months from now up to three ahead, once', async () => {
      const now = new Date('2098-12-15T00:00:00Z');
      expect(await createEventPartitions(operatorDb, now)).toBe(4);
      expect(await createEventPartitions(operatorDb, now)).toBe(0);
      const { rows } = await sql<{ name: string }>`
        select c.relname as name from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'events'::regclass and c.relname like 'events_209%'`.execute(
        operatorDb
      );
      expect(rows.map((r) => r.name).sort()).toEqual(created.map((m) => `events_${m}`));
    });

    it('refuses a month with rows in events_default, names month, count and a recovery that works', async () => {
      // Everything happens in one transaction that is rolled back: events_default is never
      // visibly filled for the suites that run beside this one.
      const client = new pg.Client({ connectionString: operatorUrl });
      await client.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        for (const day of ['10', '11'])
          await client.query(
            `insert into events (tenant_id, id, supporter_id, schema, type, email, occurred_at,
               source, source_site, source_ref)
             values ($1, $2, $3, 'wings.supporter-event.v1', 'test', 'a@example.org',
               $4, 'test', 'urn:mycel:test', $2)`,
            [tenantId, `${run}-${day}`, uuidv7(), `2097-05-${day}T12:00:00Z`]
          );
        await client.query('savepoint before');
        const error = await client
          .query(`select ensure_event_partitions('2097-04-01', '2097-06-01')`)
          .then(
            () => null,
            (e: Error) => e
          );
        expect(error?.message).toMatch(/events_default holds 2 row\(s\) from 2097-05/);
        await client.query('rollback to savepoint before');
        // Nothing half done: not even April, which had no stray rows.
        const exists = async (m: string) =>
          (await client.query(`select to_regclass($1) as t`, [`public.events_${m}`])).rows[0].t;
        expect(await exists('2097_04')).toBeNull();
        expect(await exists('2097_05')).toBeNull();

        // The recovery the message names, run as written.
        const recovery = /Move them in one transaction as the schema owner: (.*)$/.exec(
          error!.message
        )![1]!;
        await client.query(recovery);
        expect(await exists('2097_05')).not.toBeNull();
        const { rows } = await client.query(
          `select (select count(*) from events_2097_05)::int as moved,
                  (select count(*) from events_default
                   where occurred_at >= '2097-05-01T00:00:00Z')::int as stray`
        );
        expect(rows[0]).toEqual({ moved: 2, stray: 0 });
      } finally {
        await client.query('rollback');
        await client.end();
      }
    });
  });

  it('sweeps rate-limit windows as the janitor from a job', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const old = createUnitOfWork(appDb, {
      clock: { now: () => twoDaysAgo },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
    await old.run(admin(), (ctx) =>
      ctx.rateLimits.hit(`jobs-${run}`, { max: 5, windowSeconds: 60 })
    );
    const t = type('sweep');
    await due(t);
    const result = await runJobs(
      operatorDb,
      { [t]: () => sweepRateLimits(operatorDb).then(() => {}) },
      {
        types: [t],
      }
    );
    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0 });
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from rate_limits where key = ${`jobs-${run}`}`.execute(operatorDb);
    expect(rows[0]!.n).toBe(0);
  });
});
