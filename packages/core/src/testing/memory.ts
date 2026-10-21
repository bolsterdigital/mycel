// In-memory implementations of every port (ADR 001 consequence: the core is testable without a
// database). Used by core tests and by front tests (api, mcp) that need a working runtime.
// Not transactional: a thrown use case leaves partial writes, which the tests do not rely on.

import type { FormDefinition, Submission } from '../forms/model.js';
import type { FormRepository, RateLimiter, SubmissionRepository } from '../forms/ports.js';
import type { Page } from '../content/model.js';
import type { PageRepository } from '../content/ports.js';
import type { MailMessage, Mailer } from '../mailing/ports.js';
import type {
  Clock,
  DomainEvent,
  Ids,
  Signer,
  Subscriber,
  TransactionContext,
  UnitOfWork,
} from '../ports.js';
import type { Principal } from '../principal.js';
import type { SupporterEvent } from '../supporters/events.js';
import type { SupporterProjection } from '../supporters/model.js';
import type { SupporterRepository } from '../supporters/ports.js';
import type { TenantDirectory, TenantInfo } from '../tenants/ports.js';

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

export class MemoryMailer implements Mailer {
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage): Promise<{ id: string }> {
    this.sent.push(message);
    return { id: `mem-${this.sent.length}` };
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
  submissions: Submission[];
  counters: Map<string, number>;
  events: Map<string, SupporterEvent>;
  /** Keyed by supporter id. */
  projections: Map<string, SupporterProjection>;
}

/** All tenants' data, keyed by tenant id: isolation is by construction, like RLS. */
export class MemoryStore {
  readonly tenants = new Map<string, TenantStore>();
  readonly outbox: DomainEvent[] = [];

  for(tenantId: string): TenantStore {
    let store = this.tenants.get(tenantId);
    if (!store) {
      store = {
        pages: new Map(),
        forms: new Map(),
        submissions: [],
        counters: new Map(),
        events: new Map(),
        projections: new Map(),
      };
      this.tenants.set(tenantId, store);
    }
    return store;
  }
}

export interface MemoryDeps {
  store?: MemoryStore;
  clock?: Clock;
  ids?: Ids;
  signer?: Signer;
}

export class MemoryUnitOfWork implements UnitOfWork {
  readonly store: MemoryStore;
  readonly clock: Clock;
  readonly ids: Ids;
  readonly signer: Signer;

  constructor(deps: MemoryDeps = {}) {
    this.store = deps.store ?? new MemoryStore();
    this.clock = deps.clock ?? new FakeClock();
    this.ids = deps.ids ?? new SequentialIds();
    this.signer = deps.signer ?? new FakeSigner();
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
      insert: async (sub) => void s.submissions.push(structuredClone(sub)),
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
    return fn({
      principal,
      clock,
      ids: this.ids,
      signer: this.signer,
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
