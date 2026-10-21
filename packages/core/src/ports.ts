// Ports: the interfaces the domain needs from the outside world (ADR 001). Adapters implement
// them; the core never imports an implementation. Keep each port minimal: a port is a promise
// the domain makes about what it needs, not a wrapper around a library's API.

import type { Principal } from './principal.js';

export interface Clock {
  now(): Date;
}

export interface Ids {
  /** UUIDv7: time-ordered so exports and merges never collide (ADR 002). */
  next(): string;
}

/** A domain event as published by a module and consumed by others (ADR 003). */
export interface DomainEvent<TType extends string = string, TProps = Record<string, unknown>> {
  id: string;
  type: TType;
  tenantId: string;
  occurredAt: Date;
  /** Who or what caused it: an operator, an API key, an agent session, a webhook, a backfill. */
  actor: Principal['actor'];
  props: TProps;
}

export interface EventBus {
  /** Publish within the current unit of work; delivery happens after commit (outbox). */
  publish(event: DomainEvent): Promise<void>;
}

/** Unit of work: everything a use case does happens inside one tenant-scoped transaction. */
export interface UnitOfWork {
  run<T>(principal: Principal, fn: (tx: TransactionContext) => Promise<T>): Promise<T>;
}

/**
 * What a use case receives inside a transaction. Repositories are added here by each module
 * (declaration merging on this interface) so that `core` never names a database.
 */
export interface TransactionContext {
  principal: Principal;
  events: EventBus;
}
