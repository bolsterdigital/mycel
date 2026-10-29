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

/**
 * Structured log fields: scalars only, so a payload, an input or a principal object cannot ride
 * along by accident (brief #17a decision 2). Identify actors with `actorRef`, never by address.
 */
export type LogFields = Record<string, string | number | boolean | null>;

/** One JSON line per call in production (`@mycel/observability`); the adapter scrubs values. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/**
 * Unexpected failures, for an error tracker. Never async for the caller and never throws: a
 * broken tracker must not turn into a second failure. A `UseCaseError` is not reported.
 */
export interface ErrorReporter {
  capture(
    error: unknown,
    context?: {
      tenantId?: string | undefined;
      requestId?: string | undefined;
      job?: string | undefined;
      tags?: Record<string, string>;
    }
  ): void;
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
  /**
   * A stable rate-limit key for a client address that is not the address itself, under a key of
   * its own: rotating the signing key does not reset rate limits, and the reverse (TODO #74).
   */
  hashIp(ip: string): string;
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
  /** Carries the request or job context of the front that opened the unit of work. */
  log: Logger;
  /** The erasure register of this tenant (ADR 019 rule 8, TODO #18d). */
  erasures: Erasures;
}

/**
 * The erasure register (ADR 003 rule 5, ADR 019 rule 8; migration 0019). `register` records that
 * a supporter is erased, permanently and without the address (only `erasureEmailHash`); `apply`
 * makes every copy of every registered supporter in this tenant anonymous: events and the
 * projection become tombstones (`tombstoneEmail`, empty props and lists; type and time stay, so
 * counts hold), submissions that carry the address go, outbox props are scrubbed, mail intents
 * and queued jobs for those events go. The audit log stays: it holds pseudonymous ids only.
 *
 * `apply` is idempotent and returns how many rows it changed, so a second call returns 0. It
 * runs after a restore (`mycel erasures apply`) to erase again what an older backup brought back.
 * Over Postgres it needs the `mycel_erasure` role, which the worker and the CLI can enter and the
 * fronts cannot: a web request registers, the worker applies.
 */
export interface Erasures {
  register(supporterId: string, email: string): Promise<void>;
  apply(): Promise<number>;
  /**
   * How many registrations this tenant has and how many a backup holds (TODO #29B, 0021). A
   * registration counts as a completed erasure only once it is secured: before that, losing the
   * server and restoring the last backup brings the person back with nothing to erase them again.
   * Only the backup writes `secured` (docker/backup/backup.sh, after `restic backup`).
   */
  status(): Promise<ErasureStatus>;
}

export interface ErasureStatus {
  registered: number;
  /** Registrations a restic snapshot of this installation holds. */
  secured: number;
  /** When the oldest registration no backup holds yet was made; null when all are secured. */
  oldestUnsecuredAt: Date | null;
}
