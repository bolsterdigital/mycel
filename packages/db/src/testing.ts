// Test hygiene for suites that share one database (TODO #32). A suite that submits a form leaves
// outbox rows a worker has not drained and jobs nobody runs; on a database that outlives the run
// (a laptop, dev-server-1) the next worker on it, the e2e one included, picks them up: it sends
// their confirmations and plans a `mail.reconcile` per mail, which pile up ahead of
// recovery.conformance's claim. CI never sees it, its database is fresh. Every such suite calls
// `closeTenantWork` in `afterAll` with the tenants it created: a suite closes its own work and
// never touches another suite's.
// Rejected: one sweep over every test tenant before the run, which would need to know every
// suite's naming, and draining the outbox in each suite, which runs mail the suite never asked
// for.

import { sql, type Kysely } from 'kysely';
import type { Database } from './schema.js';

/**
 * Marks the open outbox rows and open jobs of `tenantIds` as handled, as `mycel_worker` (the
 * role that drains and claims them), so no later worker on this database acts on them. With
 * `jobTypes` it closes only jobs of those types and leaves the outbox alone: for a tenant that
 * outlives the run, like the e2e tenant probe.
 */
export async function closeTenantWork(
  operatorDb: Kysely<Database>,
  tenantIds: readonly string[],
  options: { jobTypes?: readonly string[] } = {}
): Promise<void> {
  const ids = tenantIds.filter((id) => id !== '');
  if (ids.length === 0) return;
  const types = options.jobTypes ? [...options.jobTypes] : null;
  await operatorDb.transaction().execute(async (trx) => {
    await sql`set local role mycel_worker`.execute(trx);
    if (!types)
      await sql`update outbox set processed_at = now()
                where processed_at is null and tenant_id = any(${ids}::uuid[])`.execute(trx);
    await sql`update jobs set done_at = now()
              where done_at is null and tenant_id = any(${ids}::uuid[])
                and (${types}::text[] is null or type = any(${types}::text[]))`.execute(trx);
  });
}
