// The stand of a connection as an administrator reads it (brief admin-operations-screens § 8):
// connected, needs attention, paused, or disconnected. Derived from the connection and its recent
// intents, so the connection list, its detail page and the attention list say the same
// thing. "Attention" means an administrator has work: an attempt whose outcome is unknown, a
// delivery that failed most recently, or an active connection without a signing secret. An older
// failure followed by a delivery is history, not attention.
//
// In core since the attention list (it was apps/web/src/lib/admin/connection-stand.ts), because the
// attention use cases need the same rule and every front, MCP included, must get one answer.
// Rejected: a stand column (a second truth beside the intents) and the raw state enum (active or
// paused says nothing about whether deliveries arrive). Times are `Date` or ISO strings, so the
// rule runs over records in core and over the use-case views in the admin alike.

export type ConnectionStand = 'connected' | 'attention' | 'paused' | 'off';

type Moment = Date | string;
type StandConnection = { state: string; credentialStatus: string };
type StandIntent = { state: string; updatedAt: Moment };

const SETTLED = new Set(['succeeded', 'failed', 'blocked', 'resolved']);
const ms = (at: Moment) => (typeof at === 'string' ? Date.parse(at) : at.getTime());

function newestFirst<T extends StandIntent>(intents: readonly T[]): T[] {
  return [...intents].sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt));
}

export function standOf(
  connection: StandConnection,
  intents: readonly StandIntent[]
): ConnectionStand {
  if (connection.state === 'disconnected') return 'off';
  if (intents.some((i) => i.state === 'unknown')) return 'attention';
  const settled = newestFirst(intents).find((i) => SETTLED.has(i.state));
  const failing = settled?.state === 'failed' || settled?.state === 'blocked';
  if (connection.state === 'active' && (failing || connection.credentialStatus !== 'connected'))
    return 'attention';
  return connection.state === 'paused' ? 'paused' : 'connected';
}

/**
 * Since when a connection in `attention` has asked for it: the newest reason, so a new unknown
 * outcome or a new failure is news again. A missing secret has no intent behind it and dates from
 * the connection's last change. Null when the stand is not `attention`.
 */
export function attentionSince(
  connection: StandConnection & { updatedAt: Date },
  intents: readonly (StandIntent & { updatedAt: Date })[]
): Date | null {
  if (standOf(connection, intents) !== 'attention') return null;
  const newest = newestFirst(intents);
  const unknown = newest.find((i) => i.state === 'unknown');
  const settled = newest.find((i) => SETTLED.has(i.state));
  const failed = settled?.state === 'failed' || settled?.state === 'blocked';
  // A failure asks for attention only on an active connection (see `standOf`).
  const failing = failed && connection.state === 'active' ? settled : undefined;
  const reasons = [unknown, failing].flatMap((i) => (i ? [i.updatedAt] : []));
  if (!reasons.length) return connection.updatedAt;
  return new Date(Math.max(...reasons.map(ms)));
}

/** How many recent intents the stand reads per connection, as `connection.intent.list` returns. */
export const STAND_INTENTS = 30;
