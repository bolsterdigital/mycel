// In-memory implementations of every port (ADR 001 consequence: the core is testable without a
// database). Used by core tests and by front tests (api, mcp) that need a working runtime.
// Not transactional: a thrown use case leaves partial writes, which the tests do not rely on.

import type { AuditEntry } from '../audit/model.js';
import type { AuditLog, InputHasher } from '../audit/ports.js';
import type { FormDefinition, Submission } from '../forms/model.js';
import type { FormRepository, RateLimiter, SubmissionRepository } from '../forms/ports.js';
import type { Author, Pattern, Revision, Section } from '../content/model.js';
import type {
  ContentRepository,
  EntityRepository,
  ItemRecord,
  Paged,
  SluggedRepository,
} from '../content/ports.js';
import type { MailMessage, MailSend, MailSendsRepository, Mailer } from '../mailing/ports.js';
import type {
  Clock,
  DomainEvent,
  ErrorReporter,
  Ids,
  LogFields,
  Logger,
  Signer,
  Subscriber,
  TransactionContext,
  UnitOfWork,
} from '../ports.js';
import { noopLogger } from '../util/log.js';
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
import {
  ADMISSION_WINDOW_MS,
  type SupporterAdmissions,
  type SupporterRepository,
} from '../supporters/ports.js';
import { sha256Hex } from '../util/digest.js';
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
import { appDelivery } from '../media/delivery.js';
import type { MediaRecord, NewMedia } from '../media/model.js';
import type {
  BlobStore,
  ImageProbe,
  ImageProcessor,
  MediaDelivery,
  MediaRepository,
} from '../media/ports.js';

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

/**
 * HMAC-SHA256 over Web Crypto with a fixed test key, so hashes are real (64 hex) and a different
 * key gives a different hash, without the API's node:crypto adapter.
 */
export class FakeInputHasher implements InputHasher {
  readonly #key: ReturnType<typeof globalThis.crypto.subtle.importKey>;
  constructor(key = 'mycel-test-audit-key') {
    this.#key = globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  }
  async hash(canonical: string): Promise<string> {
    const mac = await globalThis.crypto.subtle.sign(
      'HMAC',
      await this.#key,
      new TextEncoder().encode(canonical)
    );
    return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

/** The `by` argument of the platform functions in packages/db, for suites. */
export const testPlatformActor = { actorId: 'test', hasher: new FakeInputHasher() };

/** Records every delivery with its intent key; `lookup` lists what was sent to that address. */
export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  readonly keys = new Set<string>();
  readonly #log: { id: string; to: string; subject: string }[] = [];
  async send(message: MailMessage, key: string): Promise<{ providerId: string }> {
    this.sent.push(message);
    this.keys.add(key);
    const id = `mem-${this.sent.length}`;
    this.#log.push({ id, to: message.to.email.toLowerCase(), subject: message.subject });
    return { providerId: id };
  }
  async lookup(message: MailMessage): Promise<{ providerIds: string[] }> {
    const to = message.to.email.toLowerCase();
    return {
      providerIds: this.#log
        .filter((m) => m.to === to && m.subject === message.subject)
        .map((m) => m.id),
    };
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

/** Newest first by UUIDv7 id, `after` exclusive, like the keyset pages of packages/db. */
function paged<T extends { id: string }>(rows: T[], after: string | null, limit: number): Paged<T> {
  const sorted = rows
    .filter((r) => after === null || r.id < after)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const page = sorted.slice(0, limit).map((r) => structuredClone(r));
  return { rows: page, next: sorted.length > limit ? (page.at(-1)?.id ?? null) : null };
}

function entityRepository<T extends { id: string }>(rows: Map<string, T>): EntityRepository<T> {
  return {
    get: async (id) => structuredClone(rows.get(id) ?? null),
    list: async (after, limit) => paged([...rows.values()], after, limit),
    insert: async (e) => void rows.set(e.id, structuredClone(e)),
    update: async (e) => void rows.set(e.id, structuredClone(e)),
  };
}

function sluggedRepository<T extends { id: string; slug: string }>(
  rows: Map<string, T>
): SluggedRepository<T> {
  return {
    ...entityRepository(rows),
    findBySlug: async (slug) =>
      structuredClone([...rows.values()].find((r) => r.slug === slug) ?? null),
  };
}

interface TenantStore {
  items: Map<string, ItemRecord>;
  revisions: Map<string, Revision>;
  authors: Map<string, Author>;
  sections: Map<string, Section>;
  patterns: Map<string, Pattern>;
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
  /** `supporter_admissions` (0010): reserved-at keyed by the hash of tenant and address. */
  admissions: Map<string, Date>;
  /** `media` (0012), keyed by id; `usageCount` is computed from `mediaUsages`. */
  media: Map<string, NewMedia & { deletedAt: Date | null }>;
  /** `media_usages` (0012), keyed by `<media id> <ref> <block id>`. */
  mediaUsages: Map<string, { mediaId: string; ref: string; blockId: string }>;
  /** `audit_log` (0015), in insertion order. */
  audit: AuditEntry[];
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

/**
 * A `BlobStore` in a Map, shared by every tenant like a bucket. `modifiedAt` comes from the clock
 * so the orphan sweep's age test can be driven by `FakeClock.advance`.
 */
export class MemoryBlobStore implements BlobStore {
  readonly blobs = new Map<string, { bytes: Uint8Array; contentType: string; modifiedAt: Date }>();
  constructor(readonly clock: Clock = new FakeClock()) {}
  async put(key: string, bytes: Uint8Array, { contentType }: { contentType: string }) {
    this.blobs.set(key, {
      bytes: new Uint8Array(bytes),
      contentType,
      modifiedAt: this.clock.now(),
    });
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    return b ? new Uint8Array(b.bytes) : null;
  }
  async head(key: string) {
    const b = this.blobs.get(key);
    return b ? { size: b.bytes.length, contentType: b.contentType } : null;
  }
  async delete(keys: readonly string[]) {
    for (const key of keys) this.blobs.delete(key);
  }
  async *list(prefix: string) {
    for (const [key, b] of [...this.blobs].sort(([a], [z]) => a.localeCompare(z)))
      if (key.startsWith(prefix)) yield { key, size: b.bytes.length, modifiedAt: b.modifiedAt };
  }
}

const sniff = (b: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * An `ImageProcessor` without a codec: `probe` recognises the five formats by their magic bytes
 * and reads the size from a PNG's IHDR or a GIF's header (anything else is 1x1); `render` returns
 * the bytes unchanged with the requested width. Enough for the core's rules; real decoding is
 * `@mycel/media-sharp`'s contract test.
 */
export const memoryImageProcessor: ImageProcessor = {
  async probe(b) {
    const be32 = (at: number) =>
      ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
    let found: Omit<ImageProbe, 'pages'> | null = null;
    if (b.length >= 24 && b[0] === 0x89 && sniff(b, 1, 'PNG'))
      found = { format: 'png', width: be32(16), height: be32(20) };
    else if (b.length >= 10 && sniff(b, 0, 'GIF8'))
      found = { format: 'gif', width: b[6]! | (b[7]! << 8), height: b[8]! | (b[9]! << 8) };
    else if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
      found = { format: 'jpeg', width: 1, height: 1 };
    else if (b.length >= 12 && sniff(b, 0, 'RIFF') && sniff(b, 8, 'WEBP'))
      found = { format: 'webp', width: 1, height: 1 };
    else if (b.length >= 12 && sniff(b, 4, 'ftypavif'))
      found = { format: 'avif', width: 1, height: 1 };
    // A GIF header does not say how many frames follow; a test that needs frames stubs `probe`.
    return found && found.width > 0 && found.height > 0 ? { ...found, pages: 1 } : null;
  },
  async render(bytes, { width }) {
    return { bytes: new Uint8Array(bytes), width, height: width };
  },
};

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
        items: new Map(),
        revisions: new Map(),
        authors: new Map(),
        sections: new Map(),
        patterns: new Map(),
        forms: new Map(),
        submissions: new Map(),
        counters: new Map(),
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

/** Keeps every line it is given, for assertions; `child` shares the list. */
export class MemoryLogger implements Logger {
  constructor(
    readonly lines: { level: string; message: string; fields: LogFields }[] = [],
    private readonly base: LogFields = {}
  ) {}
  #push(level: string, message: string, fields: LogFields = {}) {
    this.lines.push({ level, message, fields: { ...this.base, ...fields } });
  }
  debug(message: string, fields?: LogFields) {
    this.#push('debug', message, fields);
  }
  info(message: string, fields?: LogFields) {
    this.#push('info', message, fields);
  }
  warn(message: string, fields?: LogFields) {
    this.#push('warn', message, fields);
  }
  error(message: string, fields?: LogFields) {
    this.#push('error', message, fields);
  }
  child(fields: LogFields): Logger {
    return new MemoryLogger(this.lines, { ...this.base, ...fields });
  }
}

/** Collects what would go to the error tracker. */
export class MemoryErrorReporter implements ErrorReporter {
  readonly captured: { error: unknown; context: Parameters<ErrorReporter['capture']>[1] }[] = [];
  capture(error: unknown, context?: Parameters<ErrorReporter['capture']>[1]): void {
    this.captured.push({ error, context });
  }
}

export interface MemoryDeps {
  store?: MemoryStore;
  log?: Logger;
  clock?: Clock;
  ids?: Ids;
  signer?: Signer;
  dns?: DnsResolver;
  platform?: PlatformConfig;
  blobs?: BlobStore;
  images?: ImageProcessor;
  delivery?: MediaDelivery;
  inputHasher?: InputHasher;
}

export class MemoryUnitOfWork implements UnitOfWork {
  readonly store: MemoryStore;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly signer: Signer;
  readonly dns: DnsResolver;
  readonly platform: PlatformConfig;
  readonly blobs: BlobStore;
  readonly images: ImageProcessor;
  readonly delivery: MediaDelivery;
  readonly log: Logger;
  readonly inputHasher: InputHasher;

  constructor(deps: MemoryDeps = {}) {
    this.log = deps.log ?? noopLogger;
    this.store = deps.store ?? new MemoryStore();
    this.clock = deps.clock ?? new FakeClock();
    this.ids = deps.ids ?? new SequentialIds();
    this.signer = deps.signer ?? new FakeSigner();
    this.dns = deps.dns ?? new FakeDns();
    this.platform = deps.platform ?? memoryPlatform;
    this.blobs = deps.blobs ?? new MemoryBlobStore(this.clock);
    this.images = deps.images ?? memoryImageProcessor;
    this.delivery = deps.delivery ?? appDelivery;
    this.inputHasher = deps.inputHasher ?? new FakeInputHasher();
  }

  async run<T>(principal: Principal, fn: (tx: TransactionContext) => Promise<T>): Promise<T> {
    const s = this.store.for(principal.tenantId);
    const outbox = this.store.outbox;
    const clock = this.clock;
    const content: ContentRepository = {
      // No-op, like `supporters.lock`: one process, not transactional (see the file header).
      lock: async (id) => structuredClone(s.items.get(id) ?? null),
      get: async (id) => structuredClone(s.items.get(id) ?? null),
      findBySlug: async (type, slug) =>
        structuredClone(
          [...s.items.values()].find((i) => i.type === type && i.slug === slug) ?? null
        ),
      list: async ({ type, slug }, after, limit) =>
        paged(
          [...s.items.values()].filter(
            (i) => (!type || i.type === type) && (!slug || i.slug === slug)
          ),
          after,
          limit
        ),
      async insert(item, first) {
        s.items.set(item.id, structuredClone(item));
        s.revisions.set(first.id, structuredClone(first));
      },
      save: async (item) => void s.items.set(item.id, structuredClone(item)),
      insertRevision: async (r) => void s.revisions.set(r.id, structuredClone(r)),
      async revision(itemId, revisionId) {
        const r = s.revisions.get(revisionId);
        return r && r.itemId === itemId ? structuredClone(r) : null;
      },
      async revisions(itemId, after, limit) {
        const page = paged(
          [...s.revisions.values()].filter((r) => r.itemId === itemId),
          after,
          limit
        );
        return { ...page, rows: page.rows.map(({ document: _d, ...summary }) => summary) };
      },
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
      get: async (key) => {
        const row = s.mailSends.get(key);
        return row ? { ...row } : null;
      },
      // The conditional upsert of the Postgres repository, one statement there and one
      // synchronous step here: nothing awaits between the check and the write.
      async claim(intent, { at, until, expected }) {
        const row = s.mailSends.get(intent.key);
        if (row) {
          const leased = row.claimedUntil !== null && row.claimedUntil > at;
          if (row.sentAt || row.abandonedAt || leased) return null;
          if ((row.attemptedAt?.getTime() ?? null) !== (expected?.getTime() ?? null)) return null;
        }
        const next: MailSend = {
          key: intent.key,
          subscriber: intent.subscriber,
          eventId: intent.eventId,
          sentAt: null,
          abandonedAt: null,
          providerId: null,
          lastError: null,
          ...row,
          correlation: intent.correlation,
          attemptedAt: new Date(at),
          claimedUntil: new Date(until),
          attempts: (row?.attempts ?? 0) + 1,
        };
        s.mailSends.set(intent.key, next);
        return { ...next };
      },
      async sent(key, at, providerId) {
        const row = s.mailSends.get(key);
        if (row) s.mailSends.set(key, { ...row, sentAt: new Date(at), providerId });
      },
      async failed(key, error, at) {
        const row = s.mailSends.get(key);
        if (row) s.mailSends.set(key, { ...row, lastError: error, claimedUntil: new Date(at) });
      },
      async abandon(key, at) {
        const row = s.mailSends.get(key);
        if (row && !row.sentAt && !row.abandonedAt)
          s.mailSends.set(key, { ...row, abandonedAt: new Date(at) });
      },
      siblings: async (correlation, { since, until }) =>
        [...s.mailSends.values()]
          .filter(
            (m) =>
              m.correlation === correlation &&
              m.attemptedAt !== null &&
              m.attemptedAt >= since &&
              m.attemptedAt <= until
          )
          .map((m) => ({ ...m })),
      unresolved: async (now) =>
        [...s.mailSends.values()]
          .filter(
            (m) =>
              m.attemptedAt !== null &&
              m.sentAt === null &&
              (m.claimedUntil === null || m.claimedUntil <= now)
          )
          .map((m) => ({ ...m })),
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
    const admissionKey = (email: string) =>
      sha256Hex(`${principal.tenantId}:${normalizeEmail(email)}`);
    const live = (at: Date) => clock.now().getTime() - at.getTime() < ADMISSION_WINDOW_MS;
    const admissions: SupporterAdmissions = {
      // No-op for the same reason as `supporters.lock`; the Postgres conformance proves the lock.
      async lock() {},
      count: async () => s.projections.size + [...s.admissions.values()].filter(live).length,
      async pending(email) {
        const at = s.admissions.get(await admissionKey(email));
        return at !== undefined && live(at);
      },
      async reserve(email) {
        for (const [k, at] of s.admissions) if (!live(at)) s.admissions.delete(k);
        const key = await admissionKey(email);
        if (!s.admissions.has(key)) s.admissions.set(key, clock.now());
      },
      async release(email) {
        s.admissions.delete(await admissionKey(email));
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
      storageBytes: async () =>
        [...s.media.values()].reduce((n, m) => n + (m.deletedAt ? 0 : m.totalBytes), 0),
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
    const usageCount = (id: string) =>
      [...s.mediaUsages.values()].filter((u) => u.mediaId === id).length;
    const mediaRecord = (m: NewMedia & { deletedAt: Date | null }): MediaRecord => ({
      ...structuredClone(m),
      usageCount: usageCount(m.id),
    });
    const media: MediaRepository = {
      // No-op for the same reason as `supporters.lock`; the Postgres conformance proves the lock.
      async lock() {},
      get: async (id) => {
        const m = s.media.get(id);
        return m ? mediaRecord(m) : null;
      },
      async list({ kind, cursor, limit }) {
        const all = [...s.media.values()]
          .filter((m) => !m.deletedAt && (!kind || m.kind === kind))
          .sort((a, b) => +b.createdAt - +a.createdAt || b.id.localeCompare(a.id));
        const from = cursor ? all.findIndex((m) => m.id === cursor) + 1 : 0;
        return all.slice(from, from + limit).map(mediaRecord);
      },
      async insert(m) {
        s.media.set(m.id, { ...structuredClone(m), deletedAt: null });
      },
      async update(id, patch, at) {
        const m = s.media.get(id);
        if (!m || m.deletedAt) return false;
        Object.assign(m, structuredClone(patch), { updatedAt: new Date(at) });
        return true;
      },
      async softDelete(id, at) {
        const m = s.media.get(id);
        if (!m || m.deletedAt) return false;
        m.deletedAt = new Date(at);
        return true;
      },
      async hardDelete(id) {
        const m = s.media.get(id);
        if (!m?.deletedAt) return false;
        for (const [k, u] of s.mediaUsages) if (u.mediaId === id) s.mediaUsages.delete(k);
        return s.media.delete(id);
      },
      async replaceUsages(ref, usages) {
        for (const [k, u] of s.mediaUsages) if (u.ref === ref) s.mediaUsages.delete(k);
        let n = 0;
        for (const { mediaId, blockId } of usages) {
          const key = `${mediaId} ${ref} ${blockId}`;
          if (!s.media.get(mediaId) || s.media.get(mediaId)!.deletedAt || s.mediaUsages.has(key))
            continue;
          s.mediaUsages.set(key, { mediaId, ref, blockId });
          n += 1;
        }
        return n;
      },
      idsOf: async () => [...s.media.keys()],
    };
    const audit: AuditLog = {
      record: async (entry) => void s.audit.push({ ...entry }),
      async list({ from, to, operation, actorKind, actorId, cursor, limit }) {
        const newestFirst = (a: AuditEntry, b: AuditEntry) =>
          b.occurredAt.getTime() - a.occurredAt.getTime() || b.id.localeCompare(a.id);
        const at = cursor ? s.audit.find((r) => r.id === cursor) : undefined;
        return s.audit
          .filter(
            (r) =>
              (!from || r.occurredAt >= from) &&
              (!to || r.occurredAt < to) &&
              (!operation || r.operation === operation) &&
              (!actorKind || r.actorKind === actorKind) &&
              (!actorId || r.actorId === actorId) &&
              (!at || newestFirst(at, r) < 0)
          )
          .sort(newestFirst)
          .slice(0, limit)
          .map((r) => ({ ...r }));
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
      content,
      authors: sluggedRepository(s.authors),
      sections: sluggedRepository(s.sections),
      patterns: entityRepository(s.patterns),
      forms,
      submissions,
      rateLimits,
      supporters,
      admissions,
      mailSends,
      operators,
      members,
      apiKeys,
      hostnames,
      jobs: new MemoryScheduler(store, principal.tenantId, this.ids, clock),
      usage,
      media,
      blobs: this.blobs,
      images: this.images,
      delivery: this.delivery,
      log: this.log,
      audit,
      inputHasher: this.inputHasher,
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
