// A tenant's own platform rows in memory: hostnames, usage counts, export requests, and the
// cross-tenant hostname resolution of `SiteDirectory`.

import type { UsageReader } from '../../entitlements/ports.js';
import type { Clock } from '../../ports.js';
import type { TenantExportRecord, TenantExportRepository } from '../../tenants/exports.js';
import type {
  HostnameRepository,
  ResolvedSite,
  SiteDirectory,
  TenantDirectory,
} from '../../tenants/ports.js';
import type { MemoryStore, TenantStore } from './store.js';

/** `ctx.hostnames`; an insert checks every tenant, like the primary key of `tenant_hostnames`. */
export function memoryHostnames(store: MemoryStore, s: TenantStore): HostnameRepository {
  return {
    list: async () =>
      [...s.hostnames.values()]
        .sort((a, b) =>
          a.kind !== b.kind
            ? a.kind === 'platform'
              ? -1
              : 1
            : a.hostname.localeCompare(b.hostname)
        )
        .map((h) => ({ ...h })),
    get: async (hostname) => {
      const h = s.hostnames.get(hostname);
      return h ? { ...h } : null;
    },
    async insert(row) {
      if (store.hostnameOwner(row.hostname)) return false;
      s.hostnames.set(row.hostname, {
        ...row,
        primary: false,
        checkFailures: 0,
        lastCheckedAt: null,
      });
      return true;
    },
    async setVerified(hostname, at) {
      const h = s.hostnames.get(hostname);
      if (h) h.verifiedAt = at ? new Date(at) : null;
    },
    async recordCheck(hostname, at, failures) {
      const h = s.hostnames.get(hostname);
      if (h) Object.assign(h, { lastCheckedAt: new Date(at), checkFailures: failures });
    },
    async setPrimary(hostname) {
      for (const h of s.hostnames.values()) h.primary = h.hostname === hostname;
    },
    remove: async (hostname) => s.hostnames.delete(hostname),
    primary: async () => {
      const h = [...s.hostnames.values()].find((h) => h.primary);
      return h ? { ...h } : null;
    },
  };
}

/** `ctx.usage`: the counts the entitlement limits are checked against. */
export function memoryUsage(s: TenantStore, clock: Clock): UsageReader {
  return {
    supporters: async () => s.projections.size,
    async mailsThisMonth() {
      const now = clock.now();
      return [...s.mailSends.values()].filter(
        (m) =>
          m.sentAt !== null &&
          m.sentAt.getUTCFullYear() === now.getUTCFullYear() &&
          m.sentAt.getUTCMonth() === now.getUTCMonth()
      ).length;
    },
    storageBytes: async () =>
      [...s.media.values()].reduce((n, m) => n + (m.deletedAt ? 0 : m.totalBytes), 0),
    customHostnames: async () =>
      [...s.hostnames.values()].filter((h) => h.kind === 'custom').length,
    operators: async () => s.members.size,
  };
}

/** `ctx.exports` over a MemoryStore: one queued or running export per tenant, like 0022's index. */
export function memoryExports(rows: Map<string, TenantExportRecord>): TenantExportRepository {
  const copy = (r: TenantExportRecord) => structuredClone(r);
  return {
    async request({ id, requestedBy, requestedAt }) {
      const active = [...rows.values()].find(
        (r) => r.status === 'queued' || r.status === 'running'
      );
      if (active) return { record: copy(active), created: false };
      const record: TenantExportRecord = {
        id,
        requestedBy,
        requestedAt,
        status: 'queued',
        startedAt: null,
        heartbeatAt: null,
        finishedAt: null,
        sizeBytes: null,
        sha256: null,
        schemaVersion: null,
        error: null,
        expiresAt: null,
      };
      rows.set(id, record);
      return { record: copy(record), created: true };
    },
    async get(id) {
      const r = rows.get(id);
      return r ? copy(r) : null;
    },
    async list(limit) {
      return [...rows.values()]
        .sort((a, b) => +b.requestedAt - +a.requestedAt || b.id.localeCompare(a.id))
        .slice(0, limit)
        .map(copy);
    },
  };
}

/**
 * Hostname resolution over a MemoryStore, like `createSiteDirectory` over Postgres: it reads
 * every tenant's hostnames, which only this port may do (ADR 011 rule 1, ADR 014).
 */
export class MemorySiteDirectory implements SiteDirectory {
  constructor(
    readonly store: MemoryStore,
    readonly tenants: TenantDirectory
  ) {}

  async resolve(hostname: string): Promise<ResolvedSite | null> {
    const tenantId = this.store.hostnameOwner(hostname);
    if (!tenantId) return null;
    const tenant = await this.tenants.findById(tenantId);
    const h = this.store.for(tenantId).hostnames.get(hostname);
    if (!tenant || !h) return null;
    const primary = [...this.store.for(tenantId).hostnames.values()].find((x) => x.primary);
    return {
      tenant,
      hostname: { hostname, kind: h.kind, primary: h.primary, verifiedAt: h.verifiedAt },
      primaryHostname: primary?.hostname ?? null,
      access: this.store.accessOf(tenantId),
    };
  }

  async allowed(hostname: string): Promise<boolean> {
    const found = await this.resolve(hostname);
    return !!found && (found.hostname.kind === 'platform' || found.hostname.verifiedAt !== null);
  }
}
