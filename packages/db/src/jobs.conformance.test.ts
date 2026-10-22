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
import {
  Invoker,
  RECONCILE_LAG_MS,
  buildRegistry,
  claimAttempt,
  systemPrincipal,
  useCases,
  type JobRecord,
} from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  JOB_LEASE_SECONDS,
  OUTBOX_MAX_ATTEMPTS,
  claimJobs,
  completeJob,
  createDb,
  deleteFinishedJobs,
  createEventPartitions,
  createUnitOfWork,
  ensureRecurring,
  failJob,
  migrate,
  queueLag,
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
    inputHasher: new FakeInputHasher(),
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
  /** Run `fn` as mycel_worker, the queue's own role (an owner without superuser sees nothing). */
  const asWorker = <T>(fn: (trx: typeof operatorDb) => Promise<T>) =>
    operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      return fn(trx);
    });
  /**
   * Move a job's clock as the worker (TODO #17a restpunt): on the owner connection an owner
   * without superuser touches no row under forced RLS, and the test would pass proving nothing.
   * The one-row check makes that visible.
   */
  async function asWorkerUpdate(query: ReturnType<typeof sql>): Promise<void> {
    const { numAffectedRows } = await asWorker((trx) => query.execute(trx));
    expect(numAffectedRows).toBe(1n);
  }
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
      await sql`update jobs set done_at = now()
                where done_at is null and key like ${`mail.reconcile:test-${run}:%`}`.execute(trx);
      // The outbox events of the lag test: delivered, so no drain or lag counts them again.
      await sql`update outbox set processed_at = now()
                where processed_at is null and type = ${type('lag')}`.execute(trx);
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

  it('plans mail.reconcile in the claim transaction: a rolled-back claim leaves neither', async () => {
    const intent = (name: string) => ({
      key: `test-${run}:${name}`,
      subscriber: `test-${run}`,
      eventId: uuidv7(),
      correlation: 'c'.repeat(64),
    });
    const at = new Date();
    const claim = (i: ReturnType<typeof intent>, fail: boolean) =>
      uow.run(admin(), async (ctx) => {
        const row = await claimAttempt(ctx, i, { at, expected: null, lagMs: RECONCILE_LAG_MS });
        if (fail) throw new Error('commit failed');
        return row;
      });

    const kept = intent('kept');
    expect(await claim(kept, false)).toMatchObject({ key: kept.key, attempts: 1 });
    const [job] = await byKey(`mail.reconcile:${kept.key}`);
    expect(job).toMatchObject({
      tenantId,
      type: 'mail.reconcile',
      runAt: new Date(at.getTime() + RECONCILE_LAG_MS),
      payload: { key: kept.key, subscriber: kept.subscriber, eventId: kept.eventId },
      doneAt: null,
    });

    const lost = intent('lost');
    await expect(claim(lost, true)).rejects.toThrow('commit failed');
    expect(await byKey(`mail.reconcile:${lost.key}`)).toEqual([]);
    expect(await uow.run(admin(), (ctx) => ctx.mailSends.get(lost.key))).toBeNull();
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

  // Since 0016 (#17c) mycel_app also reads its own jobs without the payload and may reset the
  // recovery columns; the rules for which job (exhausted only) are the use cases' (recovery.ts).
  it('lets mycel_app insert and read under its own tenant, never the payload', async () => {
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
    // Its own rows without the payload; no payload, type or key to change; no platform job and
    // no job for another tenant.
    const own = await withTenant(appDb, admin(), (trx) =>
      trx.selectFrom('jobs').select(['id', 'tenant_id']).execute()
    );
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((r) => r.tenant_id === tenantId)).toBe(true);
    expect(await asApp((trx) => trx.selectFrom('jobs').select('payload').execute())).toBe('42501');
    for (const change of [{ payload: '{}' }, { type: 'x' }, { key: 'x' }, { tenant_id: uuidv7() }])
      expect(await asApp((trx) => trx.updateTable('jobs').set(change).execute())).toBe('42501');
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
    await asWorkerUpdate(
      sql`update jobs set claimed_at = now() - make_interval(secs => ${JOB_LEASE_SECONDS + 1})
          where key = ${key}`
    );
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
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1, superseded: 0 });
    let [row] = await byKey(key);
    expect(row).toMatchObject({ attempts: 1, claimedAt: null, lastError: `no handler for ${t}` });
    expect(row!.runAt.getTime()).toBeGreaterThan(Date.now());

    await asWorkerUpdate(
      sql`update jobs set run_at = now() - interval '1 second' where key = ${key}`
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
    await asWorkerUpdate(
      sql`update jobs set run_at = now() - interval '1 second' where key = ${key}`
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
    const daily = { type: type('daily'), cadence: 'daily' as const };
    const monthly = { type: type('monthly'), cadence: 'monthly' as const };
    const now = new Date('2031-01-31T10:30:00Z');
    const counts = await Promise.all(
      [1, 2, 3].map(() => ensureRecurring(operatorDb, [hourly, daily, monthly], now))
    );
    expect(counts.reduce((a, b) => a + b, 0)).toBe(3);
    const [h] = await byKey(`${hourly.type}:2031-01-31T11`);
    const [d] = await byKey(`${daily.type}:2031-02-01`);
    const [m] = await byKey(`${monthly.type}:2031-02`);
    expect(h).toMatchObject({ runAt: new Date('2031-01-31T11:00:00Z'), tenantId: null });
    expect(d).toMatchObject({ runAt: new Date('2031-02-01T00:00:00Z'), tenantId: null });
    expect(m).toMatchObject({ runAt: new Date('2031-02-01T00:00:00Z'), tenantId: null });
    // The next tick in the same hour plans nothing new.
    expect(await ensureRecurring(operatorDb, [hourly, daily, monthly], now)).toBe(0);
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
        // The stray rows go in as mycel_app, like ingest would (0018); the recovery is the owner's.
        await client.query('set local role mycel_app');
        await client.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
        for (const day of ['10', '11'])
          await client.query(
            `insert into events (tenant_id, id, supporter_id, schema, type, email, occurred_at,
               source, source_site, source_ref)
             values ($1, $2, $3, 'wings.supporter-event.v1', 'test', 'a@example.org',
               $4, 'test', 'urn:mycel:test', $2)`,
            [tenantId, `${run}-${day}`, uuidv7(), `2097-05-${day}T12:00:00Z`]
          );
        await client.query('reset role');
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
      inputHasher: new FakeInputHasher(),
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
    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, superseded: 0 });
    // Counted as the janitor: the owner without superuser would see no row and always count 0.
    const { rows } = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_janitor`.execute(trx);
      return sql<{ n: number }>`
        select count(*)::int as n from rate_limits where key = ${`jobs-${run}`}`.execute(trx);
    });
    expect(rows[0]!.n).toBe(0);
  });

  // TODO #17a: what the worker's `/readyz` and `/metrics` read. The numbers are global, and the
  // other suites run beside this one, so the fixture proves lower bounds: its own rows are in.
  it('measures queue lag: a waiting job, an exhausted job, a dead and a pending event', async () => {
    const waiting = type('lag-waiting');
    await asWorker((trx) =>
      trx
        .insertInto('jobs')
        .values([
          {
            id: uuidv7(),
            tenant_id: null,
            type: waiting,
            key: `${waiting}:${uuidv7()}`,
            run_at: new Date(Date.now() - 10 * 60 * 1000),
            payload: '{}',
          },
          {
            id: uuidv7(),
            tenant_id: null,
            type: type('lag-exhausted'),
            key: `${type('lag-exhausted')}:${uuidv7()}`,
            run_at: new Date(Date.now() - 1000),
            payload: '{}',
            attempts: 3,
            max_attempts: 3,
          },
        ])
        .execute()
    );
    // Written as mycel_app under the tenant, as a use case would. The pending event waits out a
    // backoff, so the drain in db.test.ts, which runs beside this suite, does not take it.
    await withTenant(appDb, admin(), (trx) =>
      trx
        .insertInto('outbox')
        .values(
          [
            { attempts: OUTBOX_MAX_ATTEMPTS, available_at: new Date() },
            { attempts: 1, available_at: new Date(Date.now() + 60 * 60 * 1000) },
          ].map((row) => ({
            id: uuidv7(),
            tenant_id: tenantId,
            type: type('lag'),
            occurred_at: new Date(),
            created_at: new Date(Date.now() - 20 * 60 * 1000),
            actor: JSON.stringify({ kind: 'system', job: 'test' }),
            props: '{}',
            ...row,
          }))
        )
        .execute()
    );

    const lag = await queueLag(operatorDb);
    expect(lag.jobsLagSeconds).toBeGreaterThanOrEqual(10 * 60 - 5);
    expect(lag.jobsExhausted).toBeGreaterThanOrEqual(1);
    expect(lag.outboxLagSeconds).toBeGreaterThanOrEqual(20 * 60 - 5);
    expect(lag.outboxDead).toBeGreaterThanOrEqual(1);
  });

  it('counts a run that outlived its lease as superseded, not completed', async () => {
    const t = type('superseded');
    const key = await due(t);
    const outcomes: string[] = [];
    const result = await runJobs(
      operatorDb,
      {
        // While the handler runs, its lease expires and another worker claims the job.
        [t]: async (job) => {
          await asWorker((trx) =>
            sql`update jobs set attempts = attempts + 1, claimed_at = now()
                where id = ${job.id}`.execute(trx)
          );
        },
      },
      { types: [t], onRun: (_, outcome) => outcomes.push(outcome) }
    );
    expect(result).toEqual({ claimed: 1, completed: 0, failed: 0, superseded: 1 });
    expect(outcomes).toEqual(['superseded']);
    // The other run owns it: still open, not marked done by the late one.
    expect((await byKey(key))[0]).toMatchObject({ doneAt: null, attempts: 2 });
  });

  it('deletes finished jobs past retention, never an open or exhausted one', async () => {
    const t = type('retention');
    const day = 24 * 60 * 60 * 1000;
    const row = (name: string, fields: Record<string, unknown>) => ({
      id: uuidv7(),
      tenant_id: null,
      type: t,
      key: `${t}:${name}`,
      run_at: new Date(Date.now() - 90 * day),
      payload: '{}',
      ...fields,
    });
    await asWorker((trx) =>
      trx
        .insertInto('jobs')
        .values([
          row('old-done', { done_at: new Date(Date.now() - 40 * day) }),
          row('recent-done', { done_at: new Date(Date.now() - 1 * day) }),
          row('old-open', { run_at: new Date(Date.now() + day) }),
          row('old-exhausted', { attempts: 10, max_attempts: 10 }),
        ])
        .execute()
    );
    const keys = async () =>
      (
        await asWorker((trx) =>
          trx.selectFrom('jobs').select('key').where('type', '=', t).execute()
        )
      )
        .map((r) => r.key)
        .sort();

    await expect(
      uow.run(admin(), () => sql`delete from jobs where type = ${t}`.execute(appDb))
    ).rejects.toThrow(/permission denied/);
    // The restrictive policy of 0014: the worker cannot delete an open row, whatever it asks.
    const direct = await asWorker((trx) =>
      trx.deleteFrom('jobs').where('type', '=', t).where('done_at', 'is', null).executeTakeFirst()
    );
    expect(direct.numDeletedRows).toBe(0n);

    expect(await deleteFinishedJobs(operatorDb, 30)).toBeGreaterThanOrEqual(1);
    expect(await keys()).toEqual([`${t}:old-exhausted`, `${t}:old-open`, `${t}:recent-done`]);
  });
});
