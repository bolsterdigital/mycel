// The stand of a connection in the admin: the rule itself is core's `standOf` (moved there with the
// attention list, so the attention list and every front give one answer); this file keeps what only
// the admin needs, the tone and the moment of last activity. Pure and client-safe, like
// audit-words.ts.

import type { ConnectionStand } from '@mycel/core';

export { standOf } from '@mycel/core';
export type Stand = ConnectionStand;

type Intent = { state: string; updatedAt: string };

/** When the connection last tried or finished a delivery; null when it never did. */
export const lastActivity = (intents: readonly Intent[]): string | null =>
  [...intents].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt ?? null;

export const STAND_TONE: Record<Stand, 'success' | 'warning' | 'neutral'> = {
  connected: 'success',
  attention: 'warning',
  paused: 'neutral',
  off: 'neutral',
};
