// In-memory implementations of every port (ADR 001 consequence: the core is testable without a
// database). Used by core tests and by front tests (api, mcp) that need a working runtime.
// Not transactional: a thrown use case leaves partial writes, which the tests do not rely on.

import type { FormDefinition, Submission } from '../forms/model.js';
import type { FormRepository, RateLimiter, SubmissionRepository } from '../forms/ports.js';
import type { Page } from '../content/model.js';
import type { PageRepository } from '../content/ports.js';
import type {
  MailMessage,
  MailSend,
  MailSendsRepository,
  Mailer,
  SendVerdict,
} from '../mailing/ports.js';
import type {
  Clock,
  DomainEvent,
  Ids,
  Signer,
  Subscriber,
  TransactionContext,
  UnitOfWork,
} from '../ports.js';
import type { Capability, Principal } from '../principal.js';
import { normalizeEmail } from '../util/email.js';
import type { ApiKeySummary, Member, Operator } from '../operators/model.js';
import type {
  ApiKeyRecord,
  ApiKeyRepository,
  IdentityStore,
  LoginClaims,
  MembershipRepository,
  NewApiKey,
  OperatorMembership,
  OperatorRepository,
} from '../operators/ports.js';
import type { SupporterEvent } from '../supporters/events.js';
import type { SupporterProjection } from '../supporters/model.js';
import type { SupporterRepository } from '../supporters/ports.js';
import type {
  DnsResolver,
  HostnameRecord,
  HostnameRepository,
  PlatformConfig,
  ResolvedSite,
  SiteDirectory,
  TenantDirectory,
  TenantInfo,
} from '../tenants/ports.js';
import { platformHostname } from '../tenants/model.js';
import { DnsUnavailableError } from '../tenants/ports.js';
import type { JobRecord, JobRequest, Scheduler } from '../jobs/ports.js';
import type { JobType } from '../jobs/types.js';
import {
  DEFAULT_ACCESS,
  effectiveEntitlements,
  type EntitlementsDocument,
  type TenantAccess,
  type TenantStatus,
} from '../entitlements/model.js';
import type { UsageReader } from '../entitlements/ports.js';

export class FakeClock implements Clock {
  constructor(public current = new Date('2026-10-21T12:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Deterministic, valid-looking UUIDv7 strings for tests. */
export class SequentialIds implements Ids {
  #n = 0;
  next(): string {
    this.#n += 1;
    return `01900000-0000-7000-8000-${this.#n.toString(16).padStart(12, '0')}`;
  }
}

/** Not secure: "signature" is a reversed payload. Enough to test token logic in the core. */
export class FakeSigner implements Signer {
  async sign(payload: string): Promise<string> {
    return `${payload}~${[...payload].reverse().join('')}`;
  }
  async verify(token: string): Promise<string | null> {
    const i = token.lastIndexOf('~');
    if (i < 0) return null;
    const payload = token.slice(0, i);
    return [...payload].reverse().join('') === token.slice(i + 1) ? payload : null;
  }
}

/** Records every delivery with its intent key; `wasSent` answers from that record. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly keys = new Set<string>();
  async send(message: MailMessage, key: string): Promise<{ providerId: string }> {
    this.sent.push(message);
    this.keys.add(key);
    return { providerId: `mem-${this.sent.length}` };
  }
  async wasSent(key: string): Promise<SendVerdict> {
    return this.keys.has(key) ? 'sent' : 'not_sent';
  }
}

export class MemoryTenants implements TenantDirectory {
  constructor(readonly tenants: TenantInfo[] = []) {}
  async findById(id: string) {
    return this.tenants.find((t) => t.id === id) ?? null;
  }
  async findBySlug(slug: string) {
    return this.tenants.find((t) => t.slug === slug) ?? null;
  }
}

interface TenantStore {
  pages: Map<string, Page>;
  forms: Map<string, FormDefinition>;
  submissions: Map<string, Submission>;
  counters: Map<string, number>;
  events: Map<string, SupporterEvent>;
  /** Keyed by supporter id. */
  projections: Map<string, SupporterProjection>;
  /** Keyed by intent key. */
  mailSends: Map<string, MailSend>;
  /** Keyed by operator id. */
  members: Map<string, { capabilities: Capability[]; createdAt: Date }>;
  apiKeys: Map<string, NewApiKey & { lastUsedAt: Date | null; revokedAt: Date | null }>;
  /** Keyed by hostname; global uniqueness is checked across tenants by `MemoryStore.hostnameOwner`. */
  hostnames: Map<string, HostnameRecord>;
}

/** Development defaults, the shape `.env.example` gives: path form on localhost. */
export const memoryPlatform: PlatformConfig = {
  domain: 'localhost',
  devHosts: ['localhost', '127.0.0.1'],
  platformOrigin: 'http://localhost:5173',
  siteUrlMode: 'path',
};

/**
 * Answers from a table; a name without an entry is "not found", like a real resolver. A name in
 * `unavailable` answers nothing at all (a server failure or a time-out).
 */
export class FakeDns implements DnsResolver {
  readonly txtRecords = new Map<string, string[]>();
  readonly cnames = new Map<string, string>();
  readonly unavailable = new Set<string>();
  async txt(name: string): Promise<string[]> {
    if (this.unavailable.has(name)) throw new DnsUnavailableError();
    return [...(this.txtRecords.get(name) ?? [])];
  }
  async cname(name: string): Promise<string | null> {
    if (this.unavailable.has(name)) throw new DnsUnavailableError();
    return this.cnames.get(name) ?? null;
  }
}

/**
 * `ctx.jobs` over a MemoryStore: one open job per key across all tenants, like the partial
 * unique index of `jobs` (migration 0009). Not transactional, like the rest of this store.
 */
export class MemoryScheduler implements Scheduler {
  constructor(
    readonly store: MemoryStore,
    readonly tenantId: string | null,
    readonly ids: Ids = new SequentialIds(),
    readonly clock: Clock = new FakeClock()
  ) {}

  async enqueue<T extends JobType>(job: JobRequest<T>): Promise<boolean> {
    if (this.store.jobs.some((j) => j.key === job.key && j.doneAt === null)) return false;
    this.store.jobs.push({
      id: this.ids.next(),
      tenantId: this.tenantId,
      type: job.type,
      key: job.key,
      runAt: new Date(job.runAt),
      payload: structuredClone(job.payload),
      attempts: 0,
      maxAttempts: 10,
      claimedAt: null,
      doneAt: null,
      lastError: null,
      createdAt: this.clock.now(),
    });
    return true;
  }
}

/** Platform data, like the `operators` table: one row per person, no tenant. */
export interface OperatorRow {
  id: string;
  issuer: string | null;
  subject: string | null;
  email: string;
  emailVerifiedAt: Date | null;
  name: string | null;
  lastLoginAt: Date | null;
}

/** All tenants' data, keyed by tenant id: isolation is by construction, like RLS. */
export class MemoryStore {
  readonly tenants = new Map<string, TenantStore>();
  readonly outbox: DomainEvent[] = [];
  readonly operators = new Map<string, OperatorRow>();
  /** Every tenant's and the platform's jobs, like the `jobs` table. */
  readonly jobs: JobRecord[] = [];
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
      store = {
        pages: new Map(),
        forms: new Map(),
        submissions: new Map(),
        counters: new Map(),
        events: new Map(),
        projections: new Map(),
        mailSends: new Map(),
        members: new Map(),
        apiKeys: new Map(),
        hostnames: new Map(),
      };
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
   * What `upsertTenant` does on the operator connection: the platform hostname, verified, and
   * primary unless the tenant already has a primary.
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

export interface MemoryDeps {
  store?: MemoryStore;
  clock?: Clock;
  ids?: Ids;
  signer?: Signer;
  dns?: DnsResolver;
  platform?: PlatformConfig;
}

export class MemoryUnitOfWork implements UnitOfWork {
  readonly store: MemoryStore;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly signer: Signer;
  readonly dns: DnsResolver;
  readonly platform: PlatformConfig;

  constructor(deps: MemoryDeps = {}) {
    this.store = deps.store ?? new MemoryStore();
    this.clock = deps.clock ?? new FakeClock();
    this.ids = deps.ids ?? new SequentialIds();
    this.signer = deps.signer ?? new FakeSigner();
    this.dns = deps.dns ?? new FakeDns();
    this.platform = deps.platform ?? memoryPlatform;
  }

  async run<T>(principal: Principal, fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const s = this.store.for(principal.tenantId);
    const outbox = this.store.outbox;
    const clock = this.clock;
    const pages: PageRepository = {
      findBySlug: async (slug) => [...s.pages.values()].find((p) => p.slug === slug) ?? null,
      insert: async (page) => void s.pages.set(page.id, structuredClone(page)),
    };
    const forms: FormRepository = {
      findById: async (id) => s.forms.get(id) ?? null,
      insert: async (form) => void s.forms.set(form.id, structuredClone(form)),
    };
    const submissions: SubmissionRepository = {
      insert: async (sub) => void s.submissions.set(sub.id, structuredClone(sub)),
      findById: async (id) => s.submissions.get(id) ?? null,
      async confirm(id, at) {
        const sub = s.submissions.get(id);
        if (!sub || sub.confirmedAt) return false;
        sub.confirmedAt = new Date(at);
        return true;
      },
    };
    const mailSends: MailSendsRepository = {
      get: async (key) => s.mailSends.get(key) ?? null,
      async attempt(intent, at) {
        const row = s.mailSends.get(intent.key) ?? {
          ...intent,
          attemptedAt: null,
          sentAt: null,
          providerId: null,
          lastError: null,
        };
        s.mailSends.set(intent.key, { ...row, attemptedAt: new Date(at) });
      },
      async sent(key, at, providerId) {
        const row = s.mailSends.get(key);
        if (row) s.mailSends.set(key, { ...row, sentAt: new Date(at), providerId });
      },
      async failed(key, error) {
        const row = s.mailSends.get(key);
        if (row) s.mailSends.set(key, { ...row, lastError: error });
      },
    };
    const rateLimits: RateLimiter = {
      async hit(key, { max, windowSeconds }) {
        const window = Math.floor(clock.now().getTime() / (windowSeconds * 1000));
        const k = `${key}@${window}`;
        const hits = (s.counters.get(k) ?? 0) + 1;
        s.counters.set(k, hits);
        return hits <= max;
      },
    };
    const ids = this.ids;
    const supporters: SupporterRepository = {
      // No-op: this store is one process and not transactional (see above). Serialising writers
      // is a Postgres property, proven by the concurrency test in the database conformance.
      async lock() {},
      async resolve(email) {
        const found = [...s.projections.values()].find((p) => p.email === email);
        return found ? { id: found.id, isNew: false } : { id: ids.next(), isNew: true };
      },
      async appendEvent(event) {
        if (s.events.has(event.id)) return false;
        s.events.set(event.id, structuredClone(event));
        return true;
      },
      eventsFor: async (supporterId) =>
        [...s.events.values()].filter((e) => e.supporter_id === supporterId),
      getProjection: async (email) =>
        [...s.projections.values()].find((p) => p.email === email) ?? null,
      getProjectionById: async (id) => s.projections.get(id) ?? null,
      saveProjection: async (p) => void s.projections.set(p.id, structuredClone(p)),
    };
    const operatorRows = this.store.operators;
    const memberOf = (operatorId: string): Member | null => {
      const m = s.members.get(operatorId);
      const o = operatorRows.get(operatorId);
      return m && o
        ? {
            operatorId,
            email: o.email,
            name: o.name,
            capabilities: [...m.capabilities],
            pending: o.lastLoginAt === null,
          }
        : null;
    };
    const operators: OperatorRepository = {
      async forInvite(email, newId) {
        const all = [...operatorRows.values()];
        const pending = all.find((o) => o.subject === null && o.email === email);
        if (pending) return { id: pending.id };
        const verified = all.filter(
          (o) => o.subject !== null && o.email === email && o.emailVerifiedAt
        );
        if (verified.length > 1) return 'ambiguous';
        if (verified[0]) return { id: verified[0].id };
        operatorRows.set(newId, {
          id: newId,
          issuer: null,
          subject: null,
          email,
          emailVerifiedAt: null,
          name: null,
          lastLoginAt: null,
        });
        return { id: newId };
      },
    };
    const members: MembershipRepository = {
      // No-op for the same reason as `supporters.lock` below.
      async lock() {},
      list: async () =>
        [...s.members.keys()]
          .map(memberOf)
          .filter((m): m is Member => m !== null)
          .sort((a, b) => a.email.localeCompare(b.email)),
      get: async (operatorId) => memberOf(operatorId),
      findByEmail: async (email) =>
        [...s.members.keys()].map(memberOf).find((m) => m?.email === email) ?? null,
      async insert(operatorId, capabilities, at) {
        s.members.set(operatorId, { capabilities: [...capabilities], createdAt: new Date(at) });
      },
      async update(operatorId, capabilities) {
        const m = s.members.get(operatorId);
        if (!m) return false;
        m.capabilities = [...capabilities];
        return true;
      },
      remove: async (operatorId) => s.members.delete(operatorId),
    };
    const summary = (k: NewApiKey & { lastUsedAt: Date | null; revokedAt: Date | null }) =>
      ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        capabilities: [...k.capabilities],
        createdBy: structuredClone(k.createdBy),
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
        revokedAt: k.revokedAt?.toISOString() ?? null,
      }) satisfies ApiKeySummary;
    const apiKeys: ApiKeyRepository = {
      list: async () =>
        [...s.apiKeys.values()].sort((a, b) => b.id.localeCompare(a.id)).map(summary),
      async insert(key) {
        s.apiKeys.set(key.id, { ...structuredClone(key), lastUsedAt: null, revokedAt: null });
      },
      async revoke(id, at) {
        const k = s.apiKeys.get(id);
        if (!k || k.revokedAt) return false;
        k.revokedAt = new Date(at);
        return true;
      },
      createdBy: async (operatorId) =>
        [...s.apiKeys.values()]
          .filter(
            (k) =>
              !k.revokedAt &&
              k.createdBy.kind === 'operator' &&
              k.createdBy.operatorId === operatorId
          )
          .map(summary),
      async touch(id, at) {
        const k = s.apiKeys.get(id);
        if (k && (!k.lastUsedAt || at.getTime() - k.lastUsedAt.getTime() >= 60_000))
          k.lastUsedAt = new Date(at);
      },
    };
    const store = this.store;
    const usage: UsageReader = {
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
      // TODO #10: sum(size_bytes) over media
      storageBytes: async () => 0,
      customHostnames: async () =>
        [...s.hostnames.values()].filter((h) => h.kind === 'custom').length,
      operators: async () => s.members.size,
    };
    const hostnames: HostnameRepository = {
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
    return fn({
      principal,
      clock,
      ids: this.ids,
      signer: this.signer,
      dns: this.dns,
      platform: this.platform,
      events: {
        async publish(event) {
          if (event.tenantId !== principal.tenantId)
            throw new Error('event tenant differs from principal tenant');
          outbox.push(event);
        },
      },
      pages,
      forms,
      submissions,
      rateLimits,
      supporters,
      mailSends,
      operators,
      members,
      apiKeys,
      hostnames,
      jobs: new MemoryScheduler(store, principal.tenantId, this.ids, clock),
      usage,
    });
  }

  /** Deliver and clear the outbox, like the Postgres worker does after commit. */
  async drain(subscribers: readonly Subscriber[]): Promise<number> {
    const events = this.store.outbox.splice(0);
    for (const event of events)
      for (const sub of subscribers) if (sub.types.includes(event.type)) await sub.handle(event);
    return events.length;
  }
}

/**
 * The authentication-time view over a MemoryStore, like `createIdentityStore` over Postgres: it
 * reads every tenant's memberships and keys, which only this port may do (ADR 011 rule 1).
 */
export class MemoryIdentityStore implements IdentityStore {
  constructor(
    readonly store: MemoryStore,
    readonly tenants: MemoryTenants,
    readonly clock: Clock = new FakeClock(),
    readonly ids: Ids = new SequentialIds()
  ) {}

  async login(claims: LoginClaims): Promise<Operator> {
    const email = normalizeEmail(claims.email);
    const now = this.clock.now();
    const rows = [...this.store.operators.values()];
    let row = rows.find((o) => o.issuer === claims.issuer && o.subject === claims.subject);
    if (row) {
      row.emailVerifiedAt = claims.emailVerified
        ? row.email === email && row.emailVerifiedAt
          ? row.emailVerifiedAt
          : now
        : null;
      row.email = email;
      row.name = claims.name ?? row.name;
      row.lastLoginAt = now;
    } else {
      const pending = claims.emailVerified
        ? rows.find((o) => o.subject === null && o.email === email)
        : undefined;
      row = pending ?? {
        id: this.ids.next(),
        issuer: null,
        subject: null,
        email,
        emailVerifiedAt: null,
        name: null,
        lastLoginAt: null,
      };
      Object.assign(row, {
        issuer: claims.issuer,
        subject: claims.subject,
        emailVerifiedAt: claims.emailVerified ? now : null,
        name: claims.name ?? null,
        lastLoginAt: now,
      });
      this.store.operators.set(row.id, row);
    }
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    };
  }

  async membershipsOf(operatorId: string): Promise<OperatorMembership[]> {
    const out: OperatorMembership[] = [];
    for (const [tenantId, t] of this.store.tenants) {
      const m = t.members.get(operatorId);
      const info = await this.tenants.findById(tenantId);
      if (m && info)
        out.push({ tenantId, slug: info.slug, name: info.name, capabilities: [...m.capabilities] });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  }

  async apiKeyByHash(hash: string): Promise<ApiKeyRecord | null> {
    for (const [tenantId, t] of this.store.tenants)
      for (const k of t.apiKeys.values())
        if (k.keyHash === hash)
          return { id: k.id, tenantId, capabilities: [...k.capabilities], revokedAt: k.revokedAt };
    return null;
  }

  async tenantAccess(tenantId: string): Promise<TenantAccess> {
    return this.store.accessOf(tenantId);
  }
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
