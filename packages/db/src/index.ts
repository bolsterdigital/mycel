// Postgres adapter (ADR 002). The only way to touch tenant data is `withTenant`, which opens a
// transaction, sets `app.tenant_id` for its duration, and hands the use case a Kysely instance.
// Kysely over an ORM: typed SQL without a second schema language, and RLS needs real SQL anyway.
//
// Three connections, three roles: the application pool connects as `mycel_app` (subject to RLS);
// the authentication pool as `mycel_authenticator`, which can only enter `mycel_auth` (0007,
// `createIdentityStore`); the operator pool (migrations, seed, tenant directory writes, outbox
// drain, job claims, platform jobs) as the schema owner. Fronts get the unit of work and the
// identity store, never the operator pool.

import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  platformHostname,
  type Clock,
  type DnsResolver,
  type Ids,
  type PlatformConfig,
  type Principal,
  type Signer,
  type TenantDirectory,
  type TenantInfo,
  type UnitOfWork,
} from '@mycel/core';
import { hostnameRepository } from './hostnames.js';
import { insertPlatformHostname } from './platform.js';
import { jobScheduler } from './jobs.js';
import { apiKeyRepository, membershipRepository, operatorRepository } from './operators.js';
import { outboxEventBus } from './outbox.js';
import {
  formRepository,
  mailSendsRepository,
  pageRepository,
  rateLimiter,
  submissionRepository,
  supporterRepository,
} from './repositories.js';
import type { Database } from './schema.js';
import { usageReader } from './usage.js';
import { supporterAdmissions } from './admissions.js';

export type { Database } from './schema.js';
export { uuidv7, uuidv7Ids } from './ids.js';
export { drainOutbox, startOutboxWorker, type DrainResult } from './outbox.js';
export { sweepRateLimits } from './janitor.js';
export {
  JOB_LEASE_SECONDS,
  claimJobs,
  completeJob,
  createEventPartitions,
  ensureRecurring,
  failJob,
  nextPeriod,
  runJobs,
  startJobWorker,
  type Cadence,
  type JobHandler,
  type JobHandlers,
  type JobRunResult,
  type RecurringJob,
} from './jobs.js';
export { createIdentityStore } from './operators.js';
export { createSiteDirectory, SITE_CACHE_TTL_MS } from './hostnames.js';
export { FIRST_EVENT_MONTH, ensureEventPartitions, migrate } from './migrate.js';
export {
  createTenant,
  getTenant,
  getTenantBySlug,
  listTenants,
  setEntitlements,
  setStatus,
  type NewTenant,
  type PlatformTenant,
} from './platform.js';

export function createDb(connectionString: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}

/** Run `fn` inside a transaction scoped to the principal's tenant. */
export async function withTenant<T>(
  db: Kysely<Database>,
  principal: Principal,
  fn: (trx: Kysely<Database>) => Promise<T>
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    // `true` = transaction-local: the setting disappears at commit/rollback, so a pooled
    // connection can never carry one tenant's context into another's request.
    await sql`select set_config('app.tenant_id', ${principal.tenantId}, true)`.execute(trx);
    return fn(trx);
  });
}

export interface UnitOfWorkDeps {
  clock: Clock;
  ids: Ids;
  signer: Signer;
  dns: DnsResolver;
  platform: PlatformConfig;
}

export function createUnitOfWork(db: Kysely<Database>, deps: UnitOfWorkDeps): UnitOfWork {
  return {
    run(principal, fn) {
      return withTenant(db, principal, (trx) => {
        const tenantId = principal.tenantId;
        return fn({
          principal,
          clock: deps.clock,
          ids: deps.ids,
          signer: deps.signer,
          dns: deps.dns,
          platform: deps.platform,
          events: outboxEventBus(trx),
          pages: pageRepository(trx, tenantId),
          forms: formRepository(trx, tenantId),
          submissions: submissionRepository(trx, tenantId),
          rateLimits: rateLimiter(trx, tenantId, deps.clock),
          supporters: supporterRepository(trx, tenantId, deps.ids),
          admissions: supporterAdmissions(trx, tenantId, deps.clock),
          mailSends: mailSendsRepository(trx, tenantId),
          operators: operatorRepository(trx),
          members: membershipRepository(trx, tenantId),
          apiKeys: apiKeyRepository(trx, tenantId),
          hostnames: hostnameRepository(trx, tenantId),
          jobs: jobScheduler(trx, tenantId),
          usage: usageReader(trx, tenantId, deps.clock),
        });
      });
    },
  };
}

/** Read-only tenant lookup over the `tenant_directory` view (0008): what mycel_app may see. */
export function createTenantDirectory(db: Kysely<Database>): TenantDirectory {
  const toInfo = (r: {
    id: string;
    slug: string;
    name: string;
    default_locale: string;
    locales: string[];
  }): TenantInfo => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    defaultLocale: r.default_locale,
    locales: r.locales,
  });
  return {
    async findById(id) {
      const r = await db
        .selectFrom('tenant_directory')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return r ? toInfo(r) : null;
    },
    async findBySlug(slug) {
      const r = await db
        .selectFrom('tenant_directory')
        .selectAll()
        .where('slug', '=', slug)
        .executeTakeFirst();
      return r ? toInfo(r) : null;
    },
  };
}

/**
 * Platform operation (ADR 002 rule 4): create or update a tenant on the operator connection,
 * with its platform hostname `<slug>.<platform domain>` (ADR 014 rule 2): verified from the
 * start, primary unless the tenant already has a primary, never removed. Idempotent.
 */
export async function upsertTenant(
  operatorDb: Kysely<Database>,
  tenant: Omit<TenantInfo, 'id'> & { id: string },
  { platformDomain }: { platformDomain: string }
): Promise<TenantInfo> {
  return operatorDb.transaction().execute(async (trx) => {
    const row = await trx
      .insertInto('tenants')
      .values({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        default_locale: tenant.defaultLocale,
        locales: tenant.locales,
      })
      .onConflict((oc) => oc.column('slug').doUpdateSet({ name: tenant.name }))
      .returningAll()
      .executeTakeFirstOrThrow();
    await insertPlatformHostname(trx, row, platformDomain);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      defaultLocale: row.default_locale,
      locales: row.locales,
    };
  });
}
