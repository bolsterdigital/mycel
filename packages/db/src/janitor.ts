// Janitor (ADR 011 rule 2): the one cross-tenant delete in the system, expired rate-limit windows.
// Runs as `mycel_janitor` (migration 0006) for the duration of one transaction, like the outbox
// drain runs as `mycel_worker`. It is the handler of the hourly `rate_limits.sweep` job (TODO #15,
// packages/api/src/jobs.ts). Rejected: deleting from inside `forms.submit` as mycel_app, which
// would need a delete grant on tenant data for the public form path, and a cron outside the
// process, which a self-hoster has to remember.

import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/** Windows are at most an hour long (RATE_LIMITS); a day of slack keeps the counters honest. */
const KEEP = '1 day';

/** Delete rate-limit windows older than a day, across tenants; returns how many. */
export async function sweepRateLimits(operatorDb: Kysely<Database>): Promise<number> {
  return operatorDb.transaction().execute(async (trx) => {
    await sql`set local role mycel_janitor`.execute(trx);
    const { rows } = await sql<{ n: string }>`
      with gone as (
        delete from rate_limits where window_start < now() - ${KEEP}::interval returning 1
      )
      select count(*) as n from gone`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  });
}
