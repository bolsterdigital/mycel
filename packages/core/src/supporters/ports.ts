import type { SupporterEvent } from './events.js';
import type { SupporterProjection } from './model.js';

export interface SupporterRepository {
  /** Append to the log; false when an event with this id already exists (idempotent ingest). */
  appendEvent(event: SupporterEvent): Promise<boolean>;
  eventsFor(email: string): Promise<SupporterEvent[]>;
  getProjection(email: string): Promise<SupporterProjection | null>;
  /** Only the projector writes here (ADR 003 rule 3). */
  saveProjection(projection: SupporterProjection): Promise<void>;
}

declare module '../ports.js' {
  interface TransactionContext {
    supporters: SupporterRepository;
  }
}
