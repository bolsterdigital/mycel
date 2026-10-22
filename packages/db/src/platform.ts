// Platform operations (ADR 002 rule 4, ADR 015 rule 4, TODO #16): create and list tenants, set
// their entitlements and status. They run on the operator connection and under no tenant, so
// they are not use cases: nothing here is in the registry, reachable over MCP or callable as
// mycel_app. Two callers share these functions: the platform API (`/platform/*` in
// packages/api, for the hoster's portal) and `npm run platform` (scripts/platform.mjs, for a
// self-hoster), so both refuse and accept exactly the same things.
//
// Reads across tenants (the primary hostname in a listing, whether a platform hostname is taken)
// enter `mycel_auth` with `set local role`, like `createSiteDirectory`: `tenant_hostnames` is
// under forced RLS, which binds the schema owner too (0008). Rejected: a `platform:admin`
// capability on `api_keys` (tenant data under RLS; a key without a tenant would weaken it) and
// these operations as use cases (they have no tenant context and do not run as mycel_app).

import { sql, type Kysely } from 'kysely';
import {
  EntitlementsDocument,
  TenantStatus,
  UseCaseError,
  effectiveEntitlements,
  platformHostname,
  platformOriginHost,
  type Entitlements,
  type PlatformConfig,
} from '@mycel/core';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

export interface PlatformTenant {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  locales: string[];
  status: TenantStatus;
  primaryHostname: string | null;
  /** The document as the hoster wrote it. */
  storedEntitlements: EntitlementsDocument;
  /** That document merged over the defaults: what the tenant actually gets. */
  entitlements: Entitlements;
}

export interface NewTenant {
  id: string;
  slug: string;
  name: string;
  locales: string[];
  /** Defaults to the first locale. */
  defaultLocale?: string | undefined;
  entitlements?: EntitlementsDocument | undefined;
}

type Platform = Pick<PlatformConfig, 'domain' | 'devHosts' | 'platformOrigin'>;

/**
 * The platform hostname `<slug>.<platform domain>` of a new tenant: verified from the start,
 * primary unless the tenant already has a primary, never removed (ADR 014 rule 2). Sets the
 * tenant context for the rest of the transaction: `tenant_hostnames` is under forced RLS, which
 * binds the schema owner when it is not a superuser (managed Postgres; review of PR #8).
 */
export async function insertPlatformHostname(
  trx: Trx,
  tenant: { id: string; slug: string },
  platformDomain: string
): Promise<void> {
  await sql`select set_config('app.tenant_id', ${tenant.id}, true)`.execute(trx);
  const hasPrimary = await trx
    .selectFrom('tenant_hostnames')
    .select('hostname')
    .where('tenant_id', '=', tenant.id)
    .where('is_primary', '=', true)
    .executeTakeFirst();
  await trx
    .insertInto('tenant_hostnames')
    .values({
      hostname: platformHostname(tenant.slug, platformDomain),
      tenant_id: tenant.id,
      kind: 'platform',
      is_primary: !hasPrimary,
      verified_at: sql`now()`,
    })
    .onConflict((oc) => oc.column('hostname').doNothing())
    .execute();
}

/**
 * Run `fn` as mycel_auth inside `trx`, then return to the operator role. No `finally`: after a
 * failed statement the transaction is aborted and rolls back, role and all.
 */
async function asAuth<T>(trx: Trx, fn: () => Promise<T>): Promise<T> {
  await sql`set local role mycel_auth`.execute(trx);
  const result = await fn();
  await sql`reset role`.execute(trx);
  return result;
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

function validDocument(document: unknown): EntitlementsDocument {
  const parsed = EntitlementsDocument.safeParse(document);
  if (!parsed.success)
    throw new UseCaseError(
      'invalid_input',
      'entitlements do not match the schema',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    );
  return parsed.data;
}

/**
 * Create a tenant with its platform hostname and, optionally, its entitlements, in one
 * transaction. Refuses an existing slug, a slug whose platform hostname is the host of the
 * platform origin or a development host (the admin lives there; review of PR #8, point (c)), and
 * a slug whose platform hostname is already some tenant's hostname.
 */
export async function createTenant(
  operatorDb: Kysely<Database>,
  tenant: NewTenant,
  platform: Platform
): Promise<PlatformTenant> {
  if (!SLUG.test(tenant.slug))
    throw new UseCaseError('invalid_input', 'slug must match ^[a-z0-9][a-z0-9-]{1,62}$', [
      { path: 'slug', message: 'invalid' },
    ]);
  const entitlements = validDocument(tenant.entitlements ?? {});
  const hostname = platformHostname(tenant.slug, platform.domain);
  if (
    hostname === platformOriginHost(platform.platformOrigin) ||
    platform.devHosts.includes(hostname)
  )
    throw new UseCaseError(
      'conflict',
      `the slug "${tenant.slug}" collides with the platform address`
    );
  const locales = tenant.locales.length ? tenant.locales : ['nl'];
  const defaultLocale = tenant.defaultLocale ?? locales[0]!;
  if (!locales.includes(defaultLocale))
    throw new UseCaseError('invalid_input', 'defaultLocale must be one of locales', [
      { path: 'defaultLocale', message: 'invalid' },
    ]);

  await operatorDb.transaction().execute(async (trx) => {
    const taken = await asAuth(trx, () =>
      trx
        .selectFrom('tenant_hostnames')
        .select('hostname')
        .where('hostname', '=', hostname)
        .executeTakeFirst()
    );
    if (taken) throw new UseCaseError('conflict', `the hostname ${hostname} is already in use`);
    const row = await trx
      .insertInto('tenants')
      .values({
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
        default_locale: defaultLocale,
        locales,
        entitlements: JSON.stringify(entitlements),
      })
      .onConflict((oc) => oc.column('slug').doNothing())
      .returning(['id', 'slug'])
      .executeTakeFirst();
    if (!row) throw new UseCaseError('conflict', `a tenant with slug "${tenant.slug}" exists`);
    await insertPlatformHostname(trx, row, platform.domain);
  });
  return (await getTenant(operatorDb, tenant.id))!;
}

function tenantQuery(trx: Trx) {
  return trx
    .selectFrom('tenants as t')
    .select([
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
        .whereRef('p.tenant_id', '=', 't.id')
        .where('p.is_primary', '=', true)
        .as('primary_hostname')
    );
}

type TenantRow = Awaited<ReturnType<ReturnType<typeof tenantQuery>['executeTakeFirstOrThrow']>>;

const toTenant = (r: TenantRow): PlatformTenant => {
  const stored = EntitlementsDocument.safeParse(r.entitlements);
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    defaultLocale: r.default_locale,
    locales: r.locales,
    status: TenantStatus.parse(r.status),
    primaryHostname: r.primary_hostname ?? null,
    storedEntitlements: stored.success ? stored.data : {},
    entitlements: effectiveEntitlements(r.entitlements),
  };
};

export async function listTenants(operatorDb: Kysely<Database>): Promise<PlatformTenant[]> {
  return operatorDb
    .transaction()
    .execute(async (trx) =>
      asAuth(trx, async () => (await tenantQuery(trx).orderBy('t.slug').execute()).map(toTenant))
    );
}

export async function getTenant(
  operatorDb: Kysely<Database>,
  id: string
): Promise<PlatformTenant | null> {
  return operatorDb.transaction().execute(async (trx) =>
    asAuth(trx, async () => {
      const r = await tenantQuery(trx).where('t.id', '=', id).executeTakeFirst();
      return r ? toTenant(r) : null;
    })
  );
}

export async function getTenantBySlug(
  operatorDb: Kysely<Database>,
  slug: string
): Promise<PlatformTenant | null> {
  const r = await operatorDb
    .selectFrom('tenants')
    .select('id')
    .where('slug', '=', slug)
    .executeTakeFirst();
  return r ? getTenant(operatorDb, r.id) : null;
}

/**
 * Replace the stored document. What is stored is what the hoster sent (validated, nothing
 * unknown); the effective values are the merge. Null for an unknown tenant.
 */
export async function setEntitlements(
  operatorDb: Kysely<Database>,
  id: string,
  document: unknown
): Promise<PlatformTenant | null> {
  const valid = validDocument(document);
  const r = await operatorDb
    .updateTable('tenants')
    .set({ entitlements: JSON.stringify(valid) })
    .where('id', '=', id)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n ? getTenant(operatorDb, id) : null;
}

export async function setStatus(
  operatorDb: Kysely<Database>,
  id: string,
  status: TenantStatus
): Promise<PlatformTenant | null> {
  if (!TenantStatus.safeParse(status).success)
    throw new UseCaseError('invalid_input', 'status must be active or suspended', [
      { path: 'status', message: 'invalid' },
    ]);
  const r = await operatorDb
    .updateTable('tenants')
    .set({ status })
    .where('id', '=', id)
    .executeTakeFirst();
  return r.numUpdatedRows > 0n ? getTenant(operatorDb, id) : null;
}
