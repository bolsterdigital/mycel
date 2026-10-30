// The synthetic test is the only connection traffic Mycel sends today (TODO #49): one definition
// that the guard, the worker's source, the webhook transport and the status view all read.
// Rejected: each layer re-deriving "is this synthetic?" from string literals, which drifted.
import type { ConnectionSource } from './ports.js';
import type { ConnectionIntent } from './intents.js';

export const SYNTHETIC_SOURCE = 'synthetic.test';
export const SYNTHETIC_SCOPE = 'synthetic:test';

/** A synthetic intent carries no person and no consent scope; nothing else may claim it. */
export function isSyntheticIntent(
  row: Pick<ConnectionIntent, 'source' | 'scope' | 'supporterId'>
): boolean {
  return (
    row.source === SYNTHETIC_SOURCE && row.scope === SYNTHETIC_SCOPE && row.supporterId === null
  );
}

/** The worker's source for `connection.test`: a fixed payload, never supporter data. */
export const syntheticSource: ConnectionSource = {
  async prepare(_ctx, intent) {
    return isSyntheticIntent(intent)
      ? { ready: true, payload: { category: SYNTHETIC_SOURCE } }
      : { ready: false, failure: 'source' };
  },
};
