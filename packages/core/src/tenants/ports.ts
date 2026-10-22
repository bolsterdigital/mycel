// Tenants are platform data, not tenant-owned data (ADR 002 rule 4): the directory is a read-only
// lookup fronts use to turn a route into a tenant id before building a Principal.
//
// Hostnames (ADR 014, TODO #14) come in two shapes, like memberships and keys (operators/ports.ts):
// `SiteDirectory` answers "which site is this request for" before a tenant context exists, so
// its adapter reads across tenants through `mycel_auth` (ADR 011 rule 1); `HostnameRepository`
// runs inside a use case's tenant transaction and sees one tenant's hostnames only.

import type { TenantAccess } from '../entitlements/model.js';
import type { HostnameKind } from './model.js';

export interface TenantInfo {
  id: string;
  slug: string;
  name: string;
  defaultLocale: string;
  locales: string[];
}

export interface TenantDirectory {
  findById(id: string): Promise<TenantInfo | null>;
  findBySlug(slug: string): Promise<TenantInfo | null>;
}

/** How a hostname resolves: the tenant it belongs to and what the hostname is to that tenant. */
export interface ResolvedSite {
  tenant: TenantInfo;
  hostname: { hostname: string; kind: HostnameKind; primary: boolean; verifiedAt: Date | null };
  /** The tenant's primary hostname, where a non-primary one redirects to (ADR 014 rule 1). */
  primaryHostname: string | null;
  /** Effective entitlements and status, for the visitor's Principal (ADR 015 rule 3). */
  access: TenantAccess;
}

export interface SiteDirectory {
  /** The site a hostname belongs to, verified or not; null for an unknown hostname. */
  resolve(hostname: string): Promise<ResolvedSite | null>;
  /** True for a platform hostname or a verified custom one: what may get a certificate. */
  allowed(hostname: string): Promise<boolean>;
}

/** A row of `tenant_hostnames` as the repository returns it to the service. */
export interface HostnameRecord {
  hostname: string;
  kind: HostnameKind;
  primary: boolean;
  /** Custom hostnames only. */
  verificationToken: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  /** Consecutive daily checks that did not find the TXT record (TODO #15). */
  checkFailures: number;
  /** When a check last reached DNS; null before the first. */
  lastCheckedAt: Date | null;
}

export interface HostnameRepository {
  /** Platform hostname first, then custom ones by name. */
  list(): Promise<HostnameRecord[]>;
  get(hostname: string): Promise<HostnameRecord | null>;
  /** False when the hostname exists already, for this tenant or another (global uniqueness). */
  insert(
    row: Omit<HostnameRecord, 'primary' | 'checkFailures' | 'lastCheckedAt'>
  ): Promise<boolean>;
  setVerified(hostname: string, at: Date | null): Promise<void>;
  /** Record a check that reached DNS: when, and the consecutive failures after it. */
  recordCheck(hostname: string, at: Date, failures: number): Promise<void>;
  /** Makes `hostname` the one primary of this tenant; the previous primary stops being it. */
  setPrimary(hostname: string): Promise<void>;
  /** False when there is no such hostname. */
  remove(hostname: string): Promise<boolean>;
  primary(): Promise<HostnameRecord | null>;
}

/**
 * DNS lookups for hostname verification. `txt` and `cname` return nothing for a missing name and
 * throw `DnsUnavailableError` when DNS gave no answer at all (a server failure, a time-out):
 * that is "cannot tell now", never "not there".
 */
export interface DnsResolver {
  txt(name: string): Promise<string[]>;
  cname(name: string): Promise<string | null>;
}

export class DnsUnavailableError extends Error {
  constructor(message = 'DNS did not answer') {
    super(message);
    this.name = 'DnsUnavailableError';
  }
}

export type SiteUrlMode = 'hostnames' | 'path';

/** What the platform is called and where it lives; configuration, read-only inside a use case. */
export interface PlatformConfig {
  /** Tenants get `<slug>.<domain>` at creation (ADR 014 rule 2). */
  domain: string;
  /** Hosts that serve the `/{tenant}/...` path form (ADR 014 rule 4); empty in production. */
  devHosts: readonly string[];
  /** PUBLIC_BASE_URL: origin of the admin and the OIDC redirect; also scheme and port of every site URL. */
  platformOrigin: string;
  /** `hostnames`: site URLs use the primary hostname; `path`: the path form on platformOrigin. */
  siteUrlMode: SiteUrlMode;
}

declare module '../ports.js' {
  interface TransactionContext {
    hostnames: HostnameRepository;
    dns: DnsResolver;
    platform: PlatformConfig;
  }
}
