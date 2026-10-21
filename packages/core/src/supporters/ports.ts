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

declare module '../ports.js' {
  interface TransactionContext {
    supporters: SupporterRepository;
  }
}
