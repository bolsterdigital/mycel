// The rows of the in-memory runtime: one `TenantStore` per tenant, isolated by construction like
// RLS, plus the platform-wide tables. Also the helpers every module factory shares (keyset pages,
// the per-tenant lock). Rejected: one store per module, which would split a tenant's rows and
// make erasure, export and usage reach into a dozen objects for one question.

import type { AuditEntry } from '../../audit/model.js';
import type { AssistSettings, AssistSuggestion } from '../../assist/ports.js';
import type { ConnectionAttempt, ConnectionIntent } from '../../connections/intents.js';
import type { ConnectionRecord } from '../../connections/ports.js';
import type { Author, DocumentReference, Pattern, Revision, Section } from '../../content/model.js';
import type {
  EntityRepository,
  ItemRecord,
  Paged,
  SluggedRepository,
} from '../../content/ports.js';
import {
  DEFAULT_ACCESS,
  effectiveEntitlements,
  type EntitlementsDocument,
  type TenantAccess,
  type TenantStatus,
} from '../../entitlements/model.js';
import type { FormDefinition, Submission } from '../../forms/model.js';
import type { JobRecord } from '../../jobs/ports.js';
import type { MailSend } from '../../mailing/ports.js';
import type { NewMedia } from '../../media/model.js';
import type { NewApiKey } from '../../operators/ports.js';
import type { Capability, Principal } from '../../principal.js';
import type { DomainEvent } from '../../ports.js';
import type { SupporterEvent } from '../../supporters/events.js';
import type { SupporterProjection } from '../../supporters/model.js';
import type { BrandAsset } from '../../theme/assets.js';
import type { ResolvedTheme } from '../../theme/model.js';
import { DEFAULT_THEME } from '../../theme/presets.js';
import {
  DEFAULT_CHROME,
  DEFAULT_GENERAL,
  DEFAULT_IMAGES,
  type SiteChrome,
  type SiteGeneral,
  type SiteImages,
} from '../../theme/settings.js';
import type { OperatorPreferences } from '../../operators/preferences.js';
import type { TenantExportRecord } from '../../tenants/exports.js';
import { platformHostname } from '../../tenants/model.js';
import type { HostnameRecord, TenantInfo } from '../../tenants/ports.js';

export interface TenantStore {
  siteTheme: { version: number; value: ResolvedTheme };
  siteChrome: { version: number; value: SiteChrome };
  siteGeneral: { version: number; value: SiteGeneral };
  siteImages: { version: number; value: SiteImages };
  brandLogo: { version: number; asset: BrandAsset | null };
  brandFont: { version: number; asset: BrandAsset | null };
  connections: Map<string, ConnectionRecord>;
  connectionSecrets: Map<string, string>;
  connectionIntents: Map<string, ConnectionIntent>;
  connectionAttempts: ConnectionAttempt[];
  assistSettings: AssistSettings;
  suggestions: Map<string, AssistSuggestion>;
  assistUsage: Map<string, number>;
  items: Map<string, ItemRecord>;
  revisions: Map<string, Revision>;
  /** `content_block_refs`, keyed by revision id. */
  blockRefs: Map<string, DocumentReference[]>;
  authors: Map<string, Author>;
  sections: Map<string, Section>;
  patterns: Map<string, Pattern>;
  forms: Map<string, FormDefinition>;
  submissions: Map<string, Submission>;
  counters: Map<string, number>;
  /** `rate_limits` rows written by `cooldown`: key to the time of the last success, in ms. */
  cooldowns: Map<string, number>;
  events: Map<string, SupporterEvent>;
  /** Keyed by supporter id. */
  projections: Map<string, SupporterProjection>;
  /** Keyed by intent key. */
  mailSends: Map<string, MailSend>;
  /** Keyed by operator id. */
  members: Map<string, { capabilities: Capability[]; createdAt: Date }>;
  apiKeys: Map<string, StoredApiKey>;
  /** Keyed by hostname; global uniqueness is checked across tenants by `MemoryStore.hostnameOwner`. */
  hostnames: Map<string, HostnameRecord>;
  /** `supporter_admissions` (0010): reserved-at keyed by the hash of tenant and address. */
  admissions: Map<string, Date>;
  /** `media` (0012), keyed by id; `usageCount` is computed from `mediaUsages`. */
  media: Map<string, StoredMedia>;
  /** `media_usages` (0012), keyed by `<media id> <ref> <block id>`. */
  mediaUsages: Map<string, { mediaId: string; ref: string; blockId: string }>;
  /** `audit_log` (0015), in insertion order. */
  audit: AuditEntry[];
  /** `erasures` (0019), keyed by supporter id: the hash of the address, never the address. */
  erasures: Map<string, { emailHash: string; erasedAt: Date; actor: Principal['actor'] }>;
  /**
   * `erasure_backups` (0021), keyed by supporter id. Only the backup writes it over Postgres; a
   * suite marks a registration secured with `secureErasures`.
   */
  erasureBackups: Map<string, { snapshotId: string; securedAt: Date }>;
  /** `tenant_exports` (0022), keyed by id. The job side lives in packages/db; suites edit rows. */
  exports: Map<string, TenantExportRecord>;
}

export type StoredApiKey = NewApiKey & { lastUsedAt: Date | null; revokedAt: Date | null };
export type StoredMedia = NewMedia & { deletedAt: Date | null };

const emptyTenant = (): TenantStore => ({
  siteTheme: { version: 0, value: DEFAULT_THEME },
  siteChrome: { version: 0, value: DEFAULT_CHROME },
  siteGeneral: { version: 0, value: DEFAULT_GENERAL },
  siteImages: { version: 0, value: DEFAULT_IMAGES },
  brandLogo: { version: 0, asset: null },
  brandFont: { version: 0, asset: null },
  connections: new Map(),
  connectionSecrets: new Map(),
  connectionIntents: new Map(),
  connectionAttempts: [],
  assistSettings: {
    enabled: false,
    allowRestricted: false,
    consentedProvider: null,
    consentedBy: null,
    consentedAt: null,
  },
  suggestions: new Map(),
  assistUsage: new Map(),
  items: new Map(),
  revisions: new Map(),
  blockRefs: new Map(),
  authors: new Map(),
  sections: new Map(),
  patterns: new Map(),
  forms: new Map(),
  submissions: new Map(),
  counters: new Map(),
  cooldowns: new Map(),
  events: new Map(),
  projections: new Map(),
  mailSends: new Map(),
  members: new Map(),
  apiKeys: new Map(),
  hostnames: new Map(),
  admissions: new Map(),
  media: new Map(),
  mediaUsages: new Map(),
  audit: [],
  erasures: new Map(),
  erasureBackups: new Map(),
  exports: new Map(),
});

/** Platform data, like the `operators` table: one row per person, no tenant. */
export interface OperatorRow {
  id: string;
  issuer: string | null;
  subject: string | null;
  email: string;
  emailVerifiedAt: Date | null;
  name: string | null;
  lastLoginAt: Date | null;
  /** Absent until the operator saves preferences (#88). */
  preferences?: OperatorPreferences;
}

/** All tenants' data, keyed by tenant id: isolation is by construction, like RLS. */
export class MemoryStore {
  readonly tenants = new Map<string, TenantStore>();
  readonly outbox: DomainEvent[] = [];
  readonly operators = new Map<string, OperatorRow>();
  /** Every tenant's and the platform's jobs, like the `jobs` table. */
  readonly jobs: JobRecord[] = [];
  /** The tail of each tenant's `members.lock()` queue. */
  readonly memberLocks = new Map<string, Promise<void>>();
  /** `login_attempts` (0018): hits per `<key>:<window number>`, shared like the table. */
  readonly loginAttempts = new Map<string, number>();
  /** The tail of each tenant's `media.lock()` queue. */
  readonly mediaLocks = new Map<string, Promise<void>>();
  /** `tenants.entitlements` and `tenants.status` (0010); a tenant without a row has the defaults. */
  readonly access = new Map<string, { entitlements: EntitlementsDocument; status: TenantStatus }>();

  /** What the platform API's `setEntitlements` and `setStatus` do, in one call for tests. */
  setAccess(
    tenantId: string,
    access: { entitlements?: EntitlementsDocument; status?: TenantStatus }
  ): void {
    const current = this.access.get(tenantId) ?? { entitlements: {}, status: 'active' as const };
    this.access.set(tenantId, { ...current, ...access });
  }

  /** The effective entitlements and status, like `tenantAccess` over Postgres. */
  accessOf(tenantId: string): TenantAccess {
    const row = this.access.get(tenantId);
    return row
      ? { entitlements: effectiveEntitlements(row.entitlements), status: row.status }
      : DEFAULT_ACCESS;
  }

  for(tenantId: string): TenantStore {
    let store = this.tenants.get(tenantId);
    if (!store) {
      store = emptyTenant();
      this.tenants.set(tenantId, store);
    }
    return store;
  }

  /** The tenant holding `hostname`, across all tenants (the primary key of `tenant_hostnames`). */
  hostnameOwner(hostname: string): string | null {
    for (const [tenantId, t] of this.tenants) if (t.hostnames.has(hostname)) return tenantId;
    return null;
  }

  /**
   * What `insertPlatformHostname` (db platform.ts) does for a new tenant: the platform hostname,
   * verified, and primary unless the tenant already has a primary.
   */
  addPlatformHostname(tenant: TenantInfo, platformDomain: string, at = new Date()): void {
    const s = this.for(tenant.id);
    const hostname = platformHostname(tenant.slug, platformDomain);
    if (s.hostnames.has(hostname)) return;
    const hasPrimary = [...s.hostnames.values()].some((h) => h.primary);
    s.hostnames.set(hostname, {
      hostname,
      kind: 'platform',
      primary: !hasPrimary,
      verificationToken: null,
      verifiedAt: at,
      createdAt: at,
      checkFailures: 0,
      lastCheckedAt: null,
    });
  }
}

/** Newest first by UUIDv7 id, `after` exclusive, like the keyset pages of packages/db. */
export function paged<T extends { id: string }>(
  rows: T[],
  after: string | null,
  limit: number
): Paged<T> {
  const sorted = rows
    .filter((r) => after === null || r.id < after)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const page = sorted.slice(0, limit).map((r) => structuredClone(r));
  return { rows: page, next: sorted.length > limit ? (page.at(-1)?.id ?? null) : null };
}

export function entityRepository<T extends { id: string }>(
  rows: Map<string, T>
): EntityRepository<T> {
  return {
    get: async (id) => structuredClone(rows.get(id) ?? null),
    list: async (after, limit) => paged([...rows.values()], after, limit),
    insert: async (e) => void rows.set(e.id, structuredClone(e)),
    update: async (e) => void rows.set(e.id, structuredClone(e)),
  };
}

export function sluggedRepository<T extends { id: string; slug: string }>(
  rows: Map<string, T>
): SluggedRepository<T> {
  return {
    ...entityRepository(rows),
    findBySlug: async (slug) =>
      structuredClone([...rows.values()].find((r) => r.slug === slug) ?? null),
  };
}

/**
 * A per-tenant queue, held from `lock()` until `release()` (the end of `run`), like a
 * transaction-scoped advisory lock: a second `lock()` in the same run is a no-op, as in Postgres.
 */
export function tenantLock(tails: Map<string, Promise<void>>, tenantId: string) {
  let release: (() => void) | undefined;
  return {
    async lock() {
      if (release) return;
      const before = tails.get(tenantId) ?? Promise.resolve();
      const mine = new Promise<void>((resolve) => (release = resolve));
      tails.set(
        tenantId,
        before.then(() => mine)
      );
      await before;
    },
    release: () => release?.(),
  };
}
