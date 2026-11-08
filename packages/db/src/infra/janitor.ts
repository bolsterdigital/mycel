// Janitor (ADR 011 rule 2): the one cross-tenant delete in the system, expired rate-limit windows
// (and since TODO #20b the platform's login-limit windows, since ADR 029 expired presence rows).
// Runs as `mycel_janitor` (migration 0006) for the duration of one transaction, like the outbox
// drain runs as `mycel_worker`. It is the handler of the hourly `rate_limits.sweep` job (TODO #15,
// packages/api/src/jobs.ts). Rejected: deleting from inside `form.submit` as mycel_app, which
// would need a delete grant on tenant data for the public form path, and a cron outside the
// process, which a self-hoster has to remember.

import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';
import { asRole } from './roles.js';

/** Windows are at most an hour long (RATE_LIMITS); a day of slack keeps the counters honest. */
const KEEP = '1 day';
/** A presence row is read for about a minute (ADR 029); ten minutes is ample margin. */
const PRESENCE_KEEP = '10 minutes';

/**
 * Delete rate-limit windows older than a day, across tenants, and the login-limit windows of the
 * same age (`login_attempts`, 0018, whose janitor policies reach no younger window), and the
 * presence rows nobody reads any more (`content_presence`, 0038); returns how many rows went.
 */
export async function sweepRateLimits(operatorDb: Kysely<Database>): Promise<number> {
  return asRole(operatorDb, 'mycel_janitor', async (trx) => {
    const { rows } = await sql<{ n: string }>`
      with gone as (
        delete from rate_limits where window_start < now() - ${KEEP}::interval returning 1
      ), logins as (
        delete from login_attempts where window_start < now() - ${KEEP}::interval returning 1
      ), presence as (
        delete from content_presence
        where last_seen_at < now() - ${PRESENCE_KEEP}::interval returning 1
      )
      select (select count(*) from gone) + (select count(*) from logins)
        + (select count(*) from presence) as n`.execute(trx);
    return Number(rows[0]?.n ?? 0);
  });
}
