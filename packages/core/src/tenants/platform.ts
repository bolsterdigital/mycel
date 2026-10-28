// The rules of the platform operations (ADR 002 rule 4, ADR 015 rule 4, TODO #53 PR 4): what a
// new tenant may be called, which locales and entitlements it may start with, and which statuses
// exist. The platform API, the `mycel` CLI and the tenant import all create tenants through
// packages/db/src/platform.ts, which calls these before it writes, so a refusal reads the same
// on every route and the memory adapter could hold a tenant to the same rules.
//
// What stays in the adapter is what only storage knows: whether the slug or its hostname is
// already taken, decided by the insert under mycel_platform.
// Rejected: tenant creation as a registry use case. A use case runs under a tenant's principal
// and is an MCP tool and an OpenAPI route (ADR 009 rule 7); creating a tenant has no tenant yet,
// and ADR 002 rule 4 keeps platform operations on their own code path and role, which a
// `platform:admin` capability on a tenant's API key would undo.

import { EntitlementsDocument, TenantStatus } from '../entitlements/model.js';
import { UseCaseError } from '../errors.js';
import { platformHostname, platformOriginHost } from './model.js';
import type { PlatformConfig } from './ports.js';

/** A slug is the first label of the platform hostname, so it is a DNS label of 2 to 63 characters. */
export const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** A tenant creation never names a locale list it cannot serve; `nl` is the default site locale. */
export const DEFAULT_TENANT_LOCALES: readonly string[] = ['nl'];

export interface TenantDraft {
  slug: string;
  name: string;
  locales: readonly string[];
  /** Defaults to the first locale. */
  defaultLocale?: string | undefined;
  entitlements?: unknown;
}

/** A tenant as it will be written: every default filled in, its platform hostname derived. */
export interface PlannedTenant {
  slug: string;
  name: string;
  locales: string[];
  defaultLocale: string;
  entitlements: EntitlementsDocument;
  hostname: string;
}

/** The stored entitlements document as the hoster sent it: valid, nothing unknown. */
export function parseEntitlementsDocument(document: unknown): EntitlementsDocument {
  const parsed = EntitlementsDocument.safeParse(document);
  if (!parsed.success)
    throw new UseCaseError(
      'invalid_input',
      'entitlements do not match the schema',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    );
  return parsed.data;
}

export function parseTenantStatus(status: unknown): TenantStatus {
  const parsed = TenantStatus.safeParse(status);
  if (!parsed.success)
    throw new UseCaseError('invalid_input', 'status must be active or suspended', [
      { path: 'status', message: 'invalid' },
    ]);
  return parsed.data;
}

/**
 * Check a new tenant and fill in its defaults. Refuses a slug that is no DNS label, entitlements
 * outside the schema, a default locale outside the list, and a slug whose platform hostname is
 * the host of the platform origin or a development host (the admin lives there; review of PR #8,
 * point (c)).
 */
export function planTenant(
  draft: TenantDraft,
  platform: Pick<PlatformConfig, 'domain' | 'devHosts' | 'platformOrigin'>
): PlannedTenant {
  if (!TENANT_SLUG.test(draft.slug))
    throw new UseCaseError('invalid_input', `slug must match ${TENANT_SLUG.source}`, [
      { path: 'slug', message: 'invalid' },
    ]);
  const entitlements = parseEntitlementsDocument(draft.entitlements ?? {});
  const hostname = platformHostname(draft.slug, platform.domain);
  if (
    hostname === platformOriginHost(platform.platformOrigin) ||
    platform.devHosts.includes(hostname)
  )
    throw new UseCaseError(
      'conflict',
      `the slug "${draft.slug}" collides with the platform address`
    );
  const locales = draft.locales.length ? [...draft.locales] : [...DEFAULT_TENANT_LOCALES];
  const defaultLocale = draft.defaultLocale ?? locales[0]!;
  if (!locales.includes(defaultLocale))
    throw new UseCaseError('invalid_input', 'defaultLocale must be one of locales', [
      { path: 'defaultLocale', message: 'invalid' },
    ]);
  return { slug: draft.slug, name: draft.name, locales, defaultLocale, entitlements, hostname };
}
