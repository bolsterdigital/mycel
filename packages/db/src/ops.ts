// Operational reads and housekeeping for the worker (TODO #17a): how far the queues lag, the
// retention of finished jobs, and a liveness ping. Queue lag runs as mycel_worker, the role that
// already reads the outbox and the jobs across tenants (ADR 011 rules 1 and 2), and returns
// aggregates only: no tenant, no payload. Rejected: computing lag in the api or web process,
// which has no owner credentials and would need a new cross-tenant role for four numbers.

import { sql, type Kysely } from 'kysely';
import { JOB_LEASE_SECONDS } from './jobs.js';
import { MAX_ATTEMPTS } from './outbox.js';
import type { Database } from './schema.js';

export interface QueueLag {
  /** Age of the oldest event still owed to a subscriber and not dead; 0 when there is none. */
  outboxLagSeconds: number;
  /** Events that failed `MAX_ATTEMPTS` times without reaching every subscriber. */
  outboxDead: number;
  /** How long the oldest due, claimable job has been waiting; 0 when there is none. */
  jobsLagSeconds: number;
  /** Open jobs that used up their attempts. */
  jobsExhausted: number;
}

/** The four queue numbers, in one transaction as mycel_worker. */
export async function queueLag(operatorDb: Kysely<Database>): Promise<QueueLag> {
  return operatorDb.transaction().execute(async (trx) => {
    await sql`set local role mycel_worker`.execute(trx);
    // Both scans stay inside the partial indexes `outbox_pending` and `jobs_due`.
    const { rows } = await sql<{
      outbox_lag: string;
      outbox_dead: string;
      jobs_lag: string;
      jobs_exhausted: string;
    }>`
      select
        coalesce((select extract(epoch from now() - min(created_at)) from outbox
                  where processed_at is null and attempts < ${MAX_ATTEMPTS}), 0) as outbox_lag,
        (select count(*) from outbox
         where processed_at is null and attempts >= ${MAX_ATTEMPTS}) as outbox_dead,
        coalesce((select extract(epoch from now() - min(run_at)) from jobs
                  where done_at is null and run_at <= now() and attempts < max_attempts
                    and (claimed_at is null
                         or claimed_at < now() - make_interval(secs => ${JOB_LEASE_SECONDS}))),
                 0) as jobs_lag,
        (select count(*) from jobs
         where done_at is null and attempts >= max_attempts) as jobs_exhausted`.execute(trx);
    const r = rows[0]!;
    return {
      outboxLagSeconds: Math.max(0, Math.round(Number(r.outbox_lag))),
      outboxDead: Number(r.outbox_dead),
      jobsLagSeconds: Math.max(0, Math.round(Number(r.jobs_lag))),
      jobsExhausted: Number(r.jobs_exhausted),
    };
  });
}

/**
 * The `jobs.retention` job: delete finished jobs older than `days`, in batches of 1000 so no
 * transaction holds many row locks, until none are left. Returns how many. The restrictive delete
 * policy of 0014 makes an open job (exhausted or not) undeletable whatever this query says.
 */
export async function deleteFinishedJobs(
  operatorDb: Kysely<Database>,
  days: number
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_worker`.execute(trx);
      const { rows } = await sql<{ n: string }>`
        with gone as (
          delete from jobs where id in (
            select id from jobs
            where done_at < now() - make_interval(days => ${days})
            limit 1000)
          returning 1)
        select count(*) as n from gone`.execute(trx);
      return Number(rows[0]?.n ?? 0);
    });
    total += n;
    if (n === 0) return total;
  }
}

/** True when `select 1` answers within `timeoutMs` on this connection (`/readyz`). */
export async function ping(db: Kysely<Database>, timeoutMs = 1000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((done) => (timer = setTimeout(() => done(false), timeoutMs)));
  try {
    return await Promise.race([sql`select 1`.execute(db).then(() => true), timeout]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
