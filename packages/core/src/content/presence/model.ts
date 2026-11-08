// Who has an item open right now (ADR 029): a short-lived fact per browser tab, never a lock.
// `viewing` is a tab without input of its own, `editing` a tab with unsaved input. Nothing here
// blocks anyone, so there is nothing that can stay stuck or has to be taken over: a tab that stops
// reporting is gone once `PRESENCE_TTL_MS` has passed. Rejected: a cursor or caret per user
// (realtime stays out, ADR 018), and an explicit leave call (a closed laptop never makes it).
import { z } from 'zod';
import type { Actor } from '../../principal.js';

export const PresenceState = z.enum(['viewing', 'editing']);
export type PresenceState = z.infer<typeof PresenceState>;

/** How often an open edit screen reports. */
export const PRESENCE_BEAT_MS = 20_000;
/**
 * Three beats, plus the minute a browser may hold back the timers of a background tab, so a tab
 * with unsaved work does not flicker off while its owner reads something else.
 */
export const PRESENCE_TTL_MS = 70_000;

/** At most this many tabs are read per item; a screen has no use for more. */
export const PRESENCE_READ_LIMIT = 100;

export interface PresenceEntry {
  itemId: string;
  sessionId: string;
  actor: Actor;
  state: PresenceState;
  lastSeenAt: Date;
}
