// Helpers around the `Logger` port that need no I/O: the logger that writes nothing (a unit of
// work without a front, tests), the one way an actor appears in a log line or audit row, and the
// one way a thrown value becomes text (TODO #74; `scripts/gates/one-home.test.mjs` keeps it here).
// Rejected: passing the thrown value itself, which a `LogFields` cannot carry (scalars only) and
// which `console.error` prints with whatever the error object holds.

import type { LogFields, Logger } from '../ports.js';
import type { Actor } from '../principal.js';

export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => noopLogger,
};

/**
 * `operator:<id>`, `api-key:<id>`, `agent:<keyId>`, `system:<job>` or `anonymous`: ids only. The
 * operator actor carries an e-mail address, so the actor object itself never goes into a log
 * (brief #17a decision 3).
 */
export function actorRef(actor: Actor): string {
  switch (actor.kind) {
    case 'operator':
      return `operator:${actor.operatorId}`;
    case 'api-key':
      return `api-key:${actor.keyId}`;
    case 'agent':
      return `agent:${actor.keyId}`;
    case 'system':
      return `system:${actor.job}`;
    case 'anonymous':
      return 'anonymous';
  }
}

/** The text of a thrown value: an `Error`'s message, anything else as a string. Not scrubbed. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A thrown value as log fields; the logger scrubs the text on its way out. */
export function errorFields(e: unknown): LogFields {
  return { error: errorMessage(e) };
}
