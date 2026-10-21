// Ports: the interfaces the domain needs from the outside world (ADR 001). Adapters implement
// them; the core never imports an implementation. Keep each port minimal: a port is a promise
// the domain makes about what it needs, not a wrapper around a library's API.
//
// Module-specific ports (repositories, Mailer, RateLimiter) live next to their module in
// `<module>/ports.ts` and are added to `TransactionContext` by declaration merging, so this file
// never has to know which modules exist.

import type { Principal } from './principal.js';

export interface Clock {
  now(): Date;
}

export interface Ids {
  /** UUIDv7: time-ordered so exports and merges never collide (ADR 002). */
  next(): string;
}

/**
 * Signs and verifies short opaque strings (form timing tokens, double opt-in links). The core
 * decides what goes into a token and when it expires; the adapter only owns the key and the MAC.
 */
export interface Signer {
  sign(payload: string): Promise<string>;
  /** The original payload when the signature is valid, otherwise null. */
  verify(token: string): Promise<string | null>;
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

/**
 * An in-process consumer of domain events, fed by the outbox worker after commit. Delivery is
 * at-least-once, so `handle` must be idempotent; the worker records per subscriber which events
 * it has handled so a failure in one subscriber never replays another.
 */
export interface Subscriber {
  /** Stable name; stored in the outbox row once this subscriber has handled the event. */
  name: string;
  types: readonly string[];
  handle(event: DomainEvent): Promise<void>;
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
  clock: Clock;
  ids: Ids;
  signer: Signer;
}
