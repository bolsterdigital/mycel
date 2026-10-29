// The base of every Postgres suite (testing.md rules 3, 4 and 10): which database URLs it needs,
// a migrated schema, tenants created the way the platform creates them, and closing the work a
// suite leaves behind. A suite that needs something else here adds it here, not a local copy.
// Rejected: a second platform write path for test tenants without the audit row
// every platform mutation writes (TODO #74).
//
// Test hygiene for suites that share one database (TODO #32). A suite that submits a form leaves
// outbox rows a worker has not drained and jobs nobody runs; on a database that outlives the run
// (a laptop, dev-server-1) the next worker on it, the e2e one included, picks them up: it sends
// their confirmations and plans a `mail.reconcile` per mail, which pile up ahead of
// recovery.test's claim. CI never sees it, its database is fresh. Every such suite calls
// `closeTenantWork` in `afterAll` with the tenants it created: a suite closes its own work and
// never touches another suite's.
// Rejected: one sweep over every test tenant before the run, which would need to know every
// suite's naming, and draining the outbox in each suite, which runs mail the suite never asked
// for.

import { sql, type Kysely } from 'kysely';
import { memoryPlatform, requireServices, testPlatformActor } from '@mycel/core/testing';
import { migrate } from './migrate.js';
import { createTenant, ensureTenant, type NewTenant, type PlatformTenant } from './platform.js';
import { uuidv7 } from './ids.js';
import type { Database } from './schema.js';
import { asRole } from './roles.js';

/** A role switch for suites in other packages, through the one helper (`db-roles` ratchet). */
export { asRole } from './roles.js';

const URL_KEYS = {
  operator: 'DATABASE_URL',
  app: 'APP_DATABASE_URL',
  auth: 'AUTH_DATABASE_URL',
} as const;
type Login = Exclude<keyof typeof URL_KEYS, 'operator'>;

/**
 * The operator URL plus the URLs of `logins` (`mycel_app`, `mycel_authenticator`), read at
 * module level: `skip` when one is missing, and in CI (`E2E_REQUIRED=1`) a throw instead
 * (testing.md rule 3). The URLs are empty strings when `skip` is true.
 */
export function requireDatabase<L extends Login = never>(
  ...logins: L[]
): { skip: boolean } & Record<'operator' | L, string> {
  const names = ['operator' as const, ...logins];
  const found = requireServices(
    process.env,
    names.map((n) => URL_KEYS[n])
  );
  const urls = Object.fromEntries(names.map((n) => [n, found?.[URL_KEYS[n]] ?? '']));
  return { skip: !found, ...urls } as { skip: boolean } & Record<'operator' | L, string>;
}

/**
 * `migrate` as a suite runs it: quiet, and without passwords (testing.md rule 10). CI migrates
 * and provisions the logins before `verify`; role passwords live in the cluster, and writing
 * them again across databases raced with test role DDL (`tuple concurrently updated`).
 */
export const migrateSchema = (url: string): Promise<string[]> => migrate(url, { log: () => {} });

/**
 * A new tenant with its platform hostname on `<slug>.localhost` (or `platformDomain`), created
 * as the platform creates one, audit row included. `slug` must be new: give it a `runSuffix()`.
 * With `reuse`, an existing tenant with that slug comes back unchanged instead: for a fixture
 * whose slug is fixed because a test finds it by name on a database that outlives the run.
 */
export function testTenant(
  operatorDb: Kysely<Database>,
  slug: string,
  options: Partial<Omit<NewTenant, 'id' | 'slug'>> & {
    platformDomain?: string;
    reuse?: boolean;
  } = {}
): Promise<PlatformTenant> {
  const { platformDomain = memoryPlatform.domain, reuse = false, ...tenant } = options;
  return (reuse ? ensureTenant : createTenant)(
    operatorDb,
    { id: uuidv7(), slug, name: slug, locales: ['nl'], ...tenant },
    { ...memoryPlatform, domain: platformDomain },
    testPlatformActor
  );
}

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
  await asRole(operatorDb, 'mycel_worker', async (trx) => {
    if (!types)
      await sql`update outbox set processed_at = now()
                where processed_at is null and tenant_id = any(${ids}::uuid[])`.execute(trx);
    await sql`update jobs set done_at = now()
              where done_at is null and tenant_id = any(${ids}::uuid[])
                and (${types}::text[] is null or type = any(${types}::text[]))`.execute(trx);
  });
}
