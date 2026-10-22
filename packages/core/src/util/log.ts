// Helpers around the `Logger` port that need no I/O: the logger that writes nothing (a unit of
// work without a front, tests) and the one way an actor appears in a log line or audit row.

import type { Logger } from '../ports.js';
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
