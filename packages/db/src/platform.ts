// Platform operations (ADR 002 rule 4, ADR 015 rule 4, TODO #16): create and list tenants, set
// their entitlements and status. They run under no tenant, so they are not use cases: nothing
// here is in the registry, reachable over MCP or callable as mycel_app. Two callers share these
// functions: the platform API (`/platform/*` in packages/api, for the hoster's portal) and
// the `mycel` CLI (packages/api/src/cli.ts, for a self-hoster), so both refuse and accept exactly
// the same things. What a tenant may be is core's (`tenants/platform.ts`: slug, locales,
// entitlements, status); what stays here is what only storage knows, a slug or hostname taken.
//
// Every function is one transaction that first enters `mycel_platform` (migration 0010) through
// `asRole`. The connection `db` is the authentication login (the API) or the operator
// (the CLI, the seed); both are members of mycel_platform, and what a function can do is what
// that role can do, not what the connection can: read and insert tenants, update their
// entitlements and status, read and insert platform hostnames (policy `platform_hostnames`), and
// nothing else (ADR 011 rule 1). Rejected: the operator connection in the API process (owner
// credentials in a front), a `platform:admin` capability on `api_keys` (tenant data under RLS;
// a key without a tenant would weaken it) and these operations as use cases (they have no tenant
// context and do not run as mycel_app).
//
// Every mutation writes its audit row in the same transaction (TODO #17b decision 5): actor kind
// `platform`, the caller's `actorId` (a fingerprint of the API token, `cli`, `seed`), and a keyed
// hash of what was asked. Reads are not audited; a refused mutation writes nothing, because it
// changed nothing and an unknown tenant id cannot be referenced.

import { sql, type Kysely } from 'kysely';
import {
  EntitlementsDocument,
  TenantStatus,
  UseCaseError,
  effectiveEntitlements,
  hashInput,
  parseEntitlementsDocument,
  parseTenantStatus,
  planTenant,
  platformHostname,
  type Entitlements,
  type InputHasher,
  type PlatformConfig,
} from '@mycel/core';
import { recordPlatformAudit } from './audit.js';
import { uuidv7 } from './ids.js';
import type { Database } from './schema.js';
import { asRole } from './roles.js';

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

/** Who performs a platform mutation, for its audit row; never the token itself. */
export interface PlatformActor {
  /** The first eight hex characters of sha256(token) for the API, `cli`, `seed`. */
  actorId: string;
  /** The audit input hash (AUDIT_HASH_KEY). */
  hasher: InputHasher;
  requestId?: string | undefined;
}

async function audit(
  trx: Trx,
  by: PlatformActor,
  tenantId: string,
  action: 'tenant.create' | 'tenant.import' | 'set_entitlements' | 'set_status',
  input: unknown
): Promise<void> {
  await recordPlatformAudit(trx, {
    id: uuidv7(),
    tenantId,
    occurredAt: new Date(),
    actorKind: 'platform',
    actorId: by.actorId,
    operation: `platform.${action}`,
    effect: null,
    inputHash: await hashInput(by.hasher, input),
    result: 'ok',
    requestId: by.requestId ?? null,
    subjectId: tenantId,
  });
}

/**
 * The platform hostname `<slug>.<platform domain>` of a new tenant: verified from the start,
 * primary unless the tenant already has a primary, never removed (ADR 014 rule 2). Runs as
 * mycel_platform (`asRole`), whose `platform_hostnames` policy reads every row and inserts
 * platform rows only; no tenant context is set, and `tenant_isolation` is mycel_app's alone
 * (0010), so this role can never write a custom hostname (review round 1 of TODO #16).
 */
export async function insertPlatformHostname(
  trx: Trx,
  tenant: { id: string; slug: string },
  platformDomain: string
): Promise<void> {
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
 * Create a tenant with its platform hostname and, optionally, its entitlements, in one
 * transaction. Refuses what core `planTenant` refuses, an existing slug, and a slug whose
 * platform hostname is already some tenant's hostname.
 */
export async function createTenant(
  db: Kysely<Database>,
  tenant: NewTenant,
  platform: Platform,
  by: PlatformActor
): Promise<PlatformTenant> {
  return asRole(db, 'mycel_platform', (trx) => createTenantIn(trx, tenant, platform, by));
}

/**
 * `createTenant` inside a transaction that already runs as mycel_platform, for a caller that
 * writes more in the same transaction: the tenant import (export.ts), which must leave no tenant
 * behind when its data fails. `action` names the audit row; an import keeps the exported status.
 */
export async function createTenantIn(
  trx: Trx,
  tenant: NewTenant & { status?: TenantStatus | undefined },
  platform: Platform,
  by: PlatformActor,
  action: 'tenant.create' | 'tenant.import' = 'tenant.create'
): Promise<PlatformTenant> {
  const { hostname, locales, defaultLocale, entitlements } = planTenant(tenant, platform);
  const taken = await trx
    .selectFrom('tenant_hostnames')
    .select('hostname')
    .where('hostname', '=', hostname)
    .executeTakeFirst();
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
      ...(tenant.status ? { status: parseTenantStatus(tenant.status) } : {}),
    })
    .onConflict((oc) => oc.column('slug').doNothing())
    .returning(['id', 'slug'])
    .executeTakeFirst();
  if (!row) throw new UseCaseError('conflict', `a tenant with slug "${tenant.slug}" exists`);
  await insertPlatformHostname(trx, row, platform.domain);
  await audit(trx, by, row.id, action, {
    slug: tenant.slug,
    name: tenant.name,
    locales,
    defaultLocale,
    entitlements,
    ...(tenant.status ? { status: tenant.status } : {}),
  });
  return (await readTenant(trx, tenant.id))!;
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

async function readTenant(trx: Trx, id: string): Promise<PlatformTenant | null> {
  const r = await tenantQuery(trx).where('t.id', '=', id).executeTakeFirst();
  return r ? toTenant(r) : null;
}

export async function listTenants(db: Kysely<Database>): Promise<PlatformTenant[]> {
  return asRole(db, 'mycel_platform', async (trx) =>
    (await tenantQuery(trx).orderBy('t.slug').execute()).map(toTenant)
  );
}

export async function getTenant(db: Kysely<Database>, id: string): Promise<PlatformTenant | null> {
  return asRole(db, 'mycel_platform', (trx) => readTenant(trx, id));
}

export async function getTenantBySlug(
  db: Kysely<Database>,
  slug: string
): Promise<PlatformTenant | null> {
  return asRole(db, 'mycel_platform', async (trx) => {
    const r = await tenantQuery(trx).where('t.slug', '=', slug).executeTakeFirst();
    return r ? toTenant(r) : null;
  });
}

/**
 * Replace the stored document. What is stored is what the hoster sent (validated, nothing
 * unknown); the effective values are the merge. Null for an unknown tenant.
 */
export async function setEntitlements(
  db: Kysely<Database>,
  id: string,
  document: unknown,
  by: PlatformActor
): Promise<PlatformTenant | null> {
  const valid = parseEntitlementsDocument(document);
  return asRole(db, 'mycel_platform', async (trx) => {
    const r = await trx
      .updateTable('tenants')
      .set({ entitlements: JSON.stringify(valid) })
      .where('id', '=', id)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) return null;
    await audit(trx, by, id, 'set_entitlements', { id, entitlements: valid });
    return readTenant(trx, id);
  });
}

export async function setStatus(
  db: Kysely<Database>,
  id: string,
  status: TenantStatus,
  by: PlatformActor
): Promise<PlatformTenant | null> {
  parseTenantStatus(status);
  return asRole(db, 'mycel_platform', async (trx) => {
    const r = await trx
      .updateTable('tenants')
      .set({ status })
      .where('id', '=', id)
      .executeTakeFirst();
    if (r.numUpdatedRows === 0n) return null;
    await audit(trx, by, id, 'set_status', { id, status });
    return readTenant(trx, id);
  });
}
