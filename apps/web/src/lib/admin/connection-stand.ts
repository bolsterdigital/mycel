// The stand of a connection as an administrator reads it (brief admin-operations-screens § 8):
// connected, needs attention, paused, or disconnected, plus the moment it last did something.
// Derived from what `connection.list` and `connection.intent.list` already return, so the list
// and the detail page say the same thing. "Attention" means an administrator has work: an
// attempt whose outcome is unknown, a delivery that failed most recently, or an active
// connection without a signing secret. An older failure followed by a delivery is history, not
// attention. Pure and client-safe, like audit-words.ts; rejected: a stand column in core (it
// would be a second truth beside the intents) and the raw state enum (active/paused says
// nothing about whether deliveries arrive).

export type Stand = 'connected' | 'attention' | 'paused' | 'off';

type Connection = { state: string; credentialStatus: string };
type Intent = { state: string; updatedAt: string };

const SETTLED = new Set(['succeeded', 'failed', 'blocked', 'resolved']);

const newestFirst = (intents: readonly Intent[]) =>
  [...intents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

export function standOf(connection: Connection, intents: readonly Intent[]): Stand {
  if (connection.state === 'disconnected') return 'off';
  if (intents.some((i) => i.state === 'unknown')) return 'attention';
  const settled = newestFirst(intents).find((i) => SETTLED.has(i.state));
  const failing = settled?.state === 'failed' || settled?.state === 'blocked';
  if (connection.state === 'active' && (failing || connection.credentialStatus !== 'connected'))
    return 'attention';
  return connection.state === 'paused' ? 'paused' : 'connected';
}

/** When the connection last tried or finished a delivery; null when it never did. */
export const lastActivity = (intents: readonly Intent[]): string | null =>
  newestFirst(intents)[0]?.updatedAt ?? null;

export const STAND_TONE: Record<Stand, 'success' | 'warning' | 'neutral'> = {
  connected: 'success',
  attention: 'warning',
  paused: 'neutral',
  off: 'neutral',
};
