import type { SupporterEvent } from './events.js';
import type { SupporterProjection } from './model.js';

export interface SupporterRepository {
  /**
   * Serialise writers for one e-mail address until the transaction ends (ADR 019 rule 3). Call it
   * before `resolve`; one lock covers resolving, appending and folding.
   */
  lock(email: string): Promise<void>;
  /** The supporter id for this address, or a fresh one (`ctx.ids`) when nobody has it yet. */
  resolve(email: string): Promise<{ id: string; isNew: boolean }>;
  /** Append to the log; false when an event with this id already exists (idempotent ingest). */
  appendEvent(event: SupporterEvent & { supporter_id: string }): Promise<boolean>;
  eventsFor(supporterId: string): Promise<SupporterEvent[]>;
  getProjection(email: string): Promise<SupporterProjection | null>;
  getProjectionById(id: string): Promise<SupporterProjection | null>;
  /** Only the projector writes here (ADR 003 rule 3). */
  saveProjection(projection: SupporterProjection): Promise<void>;
}

/** How long a reservation without a projection holds its seat (`SupporterAdmissions`). */
export const ADMISSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Seats for addresses whose projection does not exist yet (ADR 015 rule 3 with ADR 019 rule 3):
 * the projection only grows after the outbox ingest, so `forms.submit` reserves the seat in its
 * own transaction and ingest releases it once the projection row exists. Serialised per tenant
 * by `lock`. A reservation older than ADMISSION_WINDOW_MS (7 days) no longer counts and is
 * swept by the next `reserve` of that tenant: a signup whose event never arrived must not hold a
 * seat forever. `release` and that window are the whole lifetime of a reservation, and it stores
 * a hash of tenant and address, not the address (ADR 019 rule 7). `UsageReader.supporters()`
 * counts the projection only (what the admin shows as supporters); `count()` here adds the
 * reservations, because a cap must hold before the worker runs. Rejected: counting
 * `submissions` (every retry of one address would count), and writing the projection from
 * forms (ADR 003 rule 3: only the projector writes it).
 */
export interface SupporterAdmissions {
  /** Serialise admissions of this tenant until the transaction ends. */
  lock(): Promise<void>;
  /** Supporters plus live reservations without a projection, in one statement (one snapshot). */
  count(): Promise<number>;
  /** Whether this address already holds a live reservation. */
  pending(email: string): Promise<boolean>;
  /** Reserve a seat for the address (idempotent); sweeps this tenant's expired reservations. */
  reserve(email: string): Promise<void>;
  /** Release after the projection exists; a missing reservation is fine. */
  release(email: string): Promise<void>;
}

declare module '../ports.js' {
  interface TransactionContext {
    supporters: SupporterRepository;
    admissions: SupporterAdmissions;
  }
}
