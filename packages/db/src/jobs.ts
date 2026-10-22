// The jobs queue (TODO #15, migration 0009; ADR 011, ADR 012 rule 4). Three halves:
//
// * `jobScheduler` is the core's `Scheduler` port inside a use case's tenant transaction as
//   mycel_app: insert only, idempotent on the open key, so a job exists if and only if the
//   change that planned it committed.
// * `claimJobs`, `completeJob` and `failJob` are the worker's side as mycel_worker. A claim is a
//   lease: one short transaction takes due jobs with SKIP LOCKED, stamps `claimed_at` and counts
//   the attempt; the handler then runs without any lock on the queue, and a second short
//   transaction marks it done or schedules the retry. A worker that dies mid-job leaves the
//   lease, and after five minutes another worker takes the job again.
// * `ensureRecurring` and `startJobWorker`: recurring platform jobs plan themselves, one row per
//   period whose key names the period, so any number of workers insert at most one.
//
// Rejected: running handlers inside the claim transaction as `drainOutbox` does (a five-second
// DNS lookup or partition DDL would hold row locks on the queue, and a crash would roll back the
// claim without a trace), a cron-expression parser (two cadences), and planning recurring jobs
// at `migrate` (a worker that runs for months without a deploy must keep itself going).

import { sql, type Kysely } from 'kysely';
import type { JobOutcome, JobRecord, Scheduler } from '@mycel/core';
import { uuidv7 } from './ids.js';
import type { Database } from './schema.js';

/** A claim older than this is free again: the worker that held it is presumed dead. */
export const JOB_LEASE_SECONDS = 300;
/** The outbox's backoff (outbox.ts): 2, 4, 8 ... seconds, at most an hour. */
const backoffSeconds = (attempts: number) => Math.min(2 ** attempts, 3600);

interface JobRow {
  id: string;
  tenant_id: string | null;
  type: string;
  key: string;
  run_at: Date;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  claimed_at: Date | null;
  done_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export const toJobRecord = (r: JobRow): JobRecord => ({
  id: r.id,
  tenantId: r.tenant_id,
  type: r.type,
  key: r.key,
  runAt: new Date(r.run_at),
  payload: r.payload,
  attempts: r.attempts,
  maxAttempts: r.max_attempts,
  claimedAt: r.claimed_at === null ? null : new Date(r.claimed_at),
  doneAt: r.done_at === null ? null : new Date(r.done_at),
  lastError: r.last_error,
  createdAt: new Date(r.created_at),
});

/** `ctx.jobs` in a tenant transaction (mycel_app may insert under its own tenant, nothing else). */
export function jobScheduler(trx: Kysely<Database>, tenantId: string): Scheduler {
  return {
    async enqueue(job) {
      const r = await trx
        .insertInto('jobs')
        .values({
          id: uuidv7(),
          tenant_id: tenantId,
          type: job.type,
          key: job.key,
          run_at: job.runAt,
          payload: JSON.stringify(job.payload),
        })
        // No conflict target: naming the arbiter (`jobs_open_key`) needs select on its columns,
        // which mycel_app does not have. The only other unique key is the fresh id, so any
        // conflict is the open key.
        .onConflict((oc) => oc.doNothing())
        .executeTakeFirst();
      return (r.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },
  };
}

/** Run `fn` in one transaction as mycel_worker (0003, 0009). */
const asWorker = <T>(operatorDb: Kysely<Database>, fn: (trx: Kysely<Database>) => Promise<T>) =>
  operatorDb.transaction().execute(async (trx) => {
    await sql`set local role mycel_worker`.execute(trx);
    return fn(trx);
  });

/**
 * Claim up to `batchSize` due jobs: open, due, not exhausted, and unclaimed or with an expired
 * lease. `types` narrows the claim (tests use their own type so they never take real work).
 */
export async function claimJobs(
  operatorDb: Kysely<Database>,
  {
    batchSize = 10,
    types,
  }: { batchSize?: number | undefined; types?: readonly string[] | undefined } = {}
): Promise<JobRecord[]> {
  const only = types ? [...types] : null;
  return asWorker(operatorDb, async (trx) => {
    const { rows } = await sql<JobRow>`
      update jobs set claimed_at = now(), attempts = attempts + 1
      where id in (
        select id from jobs
        where done_at is null and run_at <= now() and attempts < max_attempts
          and (claimed_at is null
               or claimed_at < now() - make_interval(secs => ${JOB_LEASE_SECONDS}))
          and (${only}::text[] is null or type = any(${only}::text[]))
        order by run_at, id
        limit ${batchSize}
        for update skip locked)
      returning *`.execute(trx);
    return rows.map(toJobRecord).sort((a, b) => +a.runAt - +b.runAt || a.id.localeCompare(b.id));
  });
}

/**
 * Mark a claimed job done and, when the handler asks for it, plan the same job again in the
 * same transaction. The guard on `attempts` makes this a no-op (false) if the lease expired and
 * another worker claimed the job meanwhile: that run owns it now.
 */
export async function completeJob(
  operatorDb: Kysely<Database>,
  job: JobRecord,
  outcome: JobOutcome = {}
): Promise<boolean> {
  return asWorker(operatorDb, async (trx) => {
    const r = await trx
      .updateTable('jobs')
      .set({ done_at: sql`now()`, last_error: null })
      .where('id', '=', job.id)
      .where('attempts', '=', job.attempts)
      .where('done_at', 'is', null)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) return false;
    if (outcome.next)
      await trx
        .insertInto('jobs')
        .values({
          id: uuidv7(),
          tenant_id: job.tenantId,
          type: job.type,
          key: job.key,
          run_at: outcome.next,
          payload: JSON.stringify(job.payload),
        })
        .onConflict((oc) => oc.column('key').where('done_at', 'is', null).doNothing())
        .execute();
    return true;
  });
}

/** Record a failed run: release the lease and retry after the backoff, until `max_attempts`. */
export async function failJob(
  operatorDb: Kysely<Database>,
  job: JobRecord,
  error: string
): Promise<boolean> {
  return asWorker(operatorDb, async (trx) => {
    const r = await trx
      .updateTable('jobs')
      .set({
        last_error: error,
        claimed_at: null,
        run_at: sql`now() + make_interval(secs => ${backoffSeconds(job.attempts)})`,
      })
      .where('id', '=', job.id)
      .where('attempts', '=', job.attempts)
      .where('done_at', 'is', null)
      .executeTakeFirst();
    return r.numUpdatedRows > 0n;
  });
}

export type Cadence = 'hourly' | 'daily' | 'monthly';

/** A platform job that runs once per period, planned by the worker itself. */
export interface RecurringJob {
  type: string;
  cadence: Cadence;
}

/** The first period that starts strictly after `now` (UTC), and the label its key carries. */
export function nextPeriod(cadence: Cadence, now: Date): { start: Date; label: string } {
  const [y, m, d, h] = [
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
  ];
  const start =
    cadence === 'hourly'
      ? new Date(Date.UTC(y, m, d, h + 1))
      : cadence === 'daily'
        ? new Date(Date.UTC(y, m, d + 1))
        : new Date(Date.UTC(y, m + 1, 1));
  const iso = start.toISOString();
  return { start, label: iso.slice(0, { hourly: 13, daily: 10, monthly: 7 }[cadence]) };
}

/**
 * Plan the next period of every recurring job, `<type>:<period>` at the period's start. Cheap
 * enough for every tick: a period already planned is one index conflict. Returns how many rows
 * it inserted. Only future periods are planned, so a finished period is never planned again.
 */
export async function ensureRecurring(
  operatorDb: Kysely<Database>,
  jobs: readonly RecurringJob[],
  now: Date = new Date()
): Promise<number> {
  if (jobs.length === 0) return 0;
  return asWorker(operatorDb, async (trx) => {
    let inserted = 0;
    for (const job of jobs) {
      const { start, label } = nextPeriod(job.cadence, now);
      const r = await trx
        .insertInto('jobs')
        .values({
          id: uuidv7(),
          tenant_id: null,
          type: job.type,
          key: `${job.type}:${label}`,
          run_at: start,
          payload: '{}',
        })
        .onConflict((oc) => oc.column('key').where('done_at', 'is', null).doNothing())
        .executeTakeFirst();
      inserted += Number(r.numInsertedOrUpdatedRows ?? 0n);
    }
    return inserted;
  });
}

/** What a job type runs; a tenant job's handler opens its own unit of work (packages/api). */
export type JobHandler = (job: JobRecord) => Promise<JobOutcome | void>;
export type JobHandlers = Readonly<Record<string, JobHandler>>;

export interface JobRunResult {
  claimed: number;
  completed: number;
  failed: number;
}

/** One pass: claim a batch and run each job in turn. A type without a handler is a failure. */
export async function runJobs(
  operatorDb: Kysely<Database>,
  handlers: JobHandlers,
  {
    batchSize,
    types,
    onError,
  }: {
    batchSize?: number;
    types?: readonly string[];
    onError?: (e: unknown, job: JobRecord) => void;
  } = {}
): Promise<JobRunResult> {
  const jobs = await claimJobs(operatorDb, { batchSize, types });
  const result: JobRunResult = { claimed: jobs.length, completed: 0, failed: 0 };
  for (const job of jobs) {
    const handler = Object.hasOwn(handlers, job.type) ? handlers[job.type] : undefined;
    try {
      if (!handler) throw new Error(`no handler for ${job.type}`);
      await completeJob(operatorDb, job, (await handler(job)) ?? {});
      result.completed += 1;
    } catch (e) {
      onError?.(e, job);
      await failJob(operatorDb, job, e instanceof Error ? e.message : String(e));
      result.failed += 1;
    }
  }
  return result;
}

/** Poll for due jobs until stopped. Returns a function that stops the loop and awaits the last run. */
export function startJobWorker(
  operatorDb: Kysely<Database>,
  handlers: JobHandlers,
  {
    intervalMs = 5000,
    recurring = [],
    log = console,
  }: {
    intervalMs?: number;
    recurring?: readonly RecurringJob[];
    log?: Pick<Console, 'error'>;
  } = {}
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = ensureRecurring(operatorDb, recurring)
      .catch((e) => log.error('planning recurring jobs failed:', e))
      .then(() =>
        runJobs(operatorDb, handlers, {
          onError: (e, job) => log.error(`job ${job.key} (${job.id}) failed:`, e),
        })
      )
      .then((r) => {
        // Run again immediately while there is a backlog.
        if (!stopped) timer = setTimeout(tick, r.claimed > 0 ? 0 : intervalMs);
      })
      .catch((e) => {
        log.error('job run failed:', e);
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

/**
 * The `events.partitions` job: monthly partitions from the month of `now` up to three months
 * ahead (ADR 003). Runs as the schema owner, the only role allowed to execute the function
 * (0005); it refuses with a recovery hint when `events_default` holds rows of a month (0009).
 */
export async function createEventPartitions(
  operatorDb: Kysely<Database>,
  now: Date = new Date()
): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const { rows } = await sql<{ n: number }>`
    select ensure_event_partitions(${day(from)}::date, ${day(to)}::date) as n`.execute(operatorDb);
  return rows[0]?.n ?? 0;
}
