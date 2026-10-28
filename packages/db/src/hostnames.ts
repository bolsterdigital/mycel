// Hostnames over Postgres (TODO #14, migration 0008). Two halves, the shape of operators.ts:
//
// * `hostnameRepository` runs in a use case's tenant transaction as mycel_app under RLS: one
//   tenant's hostnames, and nothing else.
// * `createSiteDirectory` answers "which site is this request for" before a tenant context
//   exists. Each lookup is one transaction that enters `mycel_auth` through `asRole`, the
//   pattern of `createIdentityStore`. Its answers are cached in this process for thirty seconds
//   per hostname (at most ten thousand entries, oldest out), so a busy site does not hit the
//   database on every request; a change in the admin is live within that window. The answer
//   carries the tenant's entitlements and status (0010, TODO #16), so a platform API change
//   reaches the public site within the same window. Rejected: a
//   cache keyed by request (no reuse), and no cache (one query per page view and per asset).

import { sql, type Kysely } from 'kysely';
import {
  TenantStatus,
  effectiveEntitlements,
  type HostnameRecord,
  type HostnameRepository,
  type ResolvedSite,
  type SiteDirectory,
  type TenantInfo,
} from '@mycel/core';
import type { Database } from './schema.js';
import { asRole } from './roles.js';

type Trx = Kysely<Database>;

interface HostnameRow {
  hostname: string;
  kind: 'platform' | 'custom';
  is_primary: boolean;
  verification_token: string | null;
  verified_at: Date | string | null;
  created_at: Date | string;
  check_failures: number;
  last_checked_at: Date | string | null;
}

const toRecord = (r: HostnameRow): HostnameRecord => ({
  hostname: r.hostname,
  kind: r.kind,
  primary: r.is_primary,
  verificationToken: r.verification_token,
  verifiedAt: r.verified_at === null ? null : new Date(r.verified_at),
  createdAt: new Date(r.created_at),
  checkFailures: r.check_failures,
  lastCheckedAt: r.last_checked_at === null ? null : new Date(r.last_checked_at),
});

const columns = [
  'hostname',
  'kind',
  'is_primary',
  'verification_token',
  'verified_at',
  'created_at',
  'check_failures',
  'last_checked_at',
] as const;

export function hostnameRepository(trx: Trx, tenantId: string): HostnameRepository {
  const rows = () => trx.selectFrom('tenant_hostnames').select(columns);
  return {
    async list() {
      return (
        await rows()
          .orderBy(sql`case kind when 'platform' then 0 else 1 end`)
          .orderBy('hostname')
          .execute()
      ).map(toRecord);
    },
    async get(hostname) {
      const r = await rows().where('hostname', '=', hostname).executeTakeFirst();
      return r ? toRecord(r) : null;
    },
    async insert(row) {
      // The primary key is global: a name held by any tenant makes this a no-op, and RLS keeps
      // the conflicting row invisible. No `returning` could tell the caller whose it is.
      const r = await trx
        .insertInto('tenant_hostnames')
        .values({
          hostname: row.hostname,
          tenant_id: tenantId,
          kind: row.kind,
          verification_token: row.verificationToken,
          verified_at: row.verifiedAt,
          created_at: row.createdAt,
        })
        .onConflict((oc) => oc.column('hostname').doNothing())
        .executeTakeFirst();
      return (r.numInsertedOrUpdatedRows ?? 0n) > 0n;
    },
    async setVerified(hostname, at) {
      await trx
        .updateTable('tenant_hostnames')
        .set({ verified_at: at })
        .where('hostname', '=', hostname)
        .execute();
    },
    async recordCheck(hostname, at, failures) {
      await trx
        .updateTable('tenant_hostnames')
        .set({ last_checked_at: at, check_failures: failures })
        .where('hostname', '=', hostname)
        .execute();
    },
    async setPrimary(hostname) {
      // Two statements in the caller's transaction; the partial unique index guards the end
      // state, and `tenant_isolation` scopes both updates to this tenant.
      await trx.updateTable('tenant_hostnames').set({ is_primary: false }).execute();
      await trx
        .updateTable('tenant_hostnames')
        .set({ is_primary: true })
        .where('hostname', '=', hostname)
        .execute();
    },
    async remove(hostname) {
      const r = await trx
        .deleteFrom('tenant_hostnames')
        .where('hostname', '=', hostname)
        .executeTakeFirst();
      return r.numDeletedRows > 0n;
    },
    async primary() {
      const r = await rows().where('is_primary', '=', true).executeTakeFirst();
      return r ? toRecord(r) : null;
    },
  };
}

export const SITE_CACHE_TTL_MS = 30_000;
export const SITE_CACHE_MAX = 10_000;

/**
 * Hostname resolution as `mycel_auth` (ADR 011 rule 1, ADR 014). `authDb` connects as
 * `mycel_authenticator` (AUTH_DATABASE_URL); the operator connection works too and is what the
 * database tests use, because it is also a member of mycel_auth (0007).
 */
export function createSiteDirectory(
  authDb: Kysely<Database>,
  { ttlMs = SITE_CACHE_TTL_MS, max = SITE_CACHE_MAX, now = Date.now } = {}
): SiteDirectory & { invalidate(hostname?: string): void } {
  const cache = new Map<string, { until: number; site: ResolvedSite | null }>();

  async function lookup(hostname: string): Promise<ResolvedSite | null> {
    const r = await asRole(authDb, 'mycel_auth', async (trx) => {
      return trx
        .selectFrom('tenant_hostnames as h')
        .innerJoin('tenants as t', 't.id', 'h.tenant_id')
        .select([
          'h.hostname',
          'h.kind',
          'h.is_primary',
          'h.verified_at',
          't.id',
          't.slug',
          't.name',
          't.default_locale',
          't.locales',
          't.entitlements',
          't.status',
        ])
        .select((eb) =>
          eb
            .selectFrom('tenant_hostnames as p')
            .select('p.hostname')
            .whereRef('p.tenant_id', '=', 'h.tenant_id')
            .where('p.is_primary', '=', true)
            .as('primary_hostname')
        )
        .where('h.hostname', '=', hostname)
        .executeTakeFirst();
    });
    if (!r) return null;
    const tenant: TenantInfo = {
      id: r.id,
      slug: r.slug,
      name: r.name,
      defaultLocale: r.default_locale,
      locales: r.locales,
    };
    return {
      tenant,
      hostname: {
        hostname: r.hostname,
        kind: r.kind,
        primary: r.is_primary,
        verifiedAt: r.verified_at === null ? null : new Date(r.verified_at),
      },
      primaryHostname: r.primary_hostname ?? null,
      access: {
        entitlements: effectiveEntitlements(r.entitlements),
        status: TenantStatus.parse(r.status),
      },
    };
  }

  async function resolve(hostname: string): Promise<ResolvedSite | null> {
    const t = now();
    const hit = cache.get(hostname);
    if (hit && hit.until > t) return hit.site;
    const site = await lookup(hostname);
    if (cache.size >= max) cache.delete(cache.keys().next().value!);
    cache.set(hostname, { until: t + ttlMs, site });
    return site;
  }

  return {
    resolve,
    async allowed(hostname) {
      const site = await resolve(hostname);
      return !!site && (site.hostname.kind === 'platform' || site.hostname.verifiedAt !== null);
    },
    /** Forget one hostname, or everything: the admin calls it after a change it just made. */
    invalidate(hostname) {
      if (hostname === undefined) cache.clear();
      else cache.delete(hostname);
    },
  };
}
