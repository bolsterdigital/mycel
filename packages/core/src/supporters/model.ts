// The supporter projection (ADR 003 rule 3, ADR 019 rule 2): a fold over the supporter's log in
// `occurred_at` order with the event id as tie-break, so every arrival order of the same events
// gives the same projection. `appliedThrough` names the last event folded in; ingest applies an
// event on top only when it sorts after that point and re-folds from the log otherwise. Rejected:
// applying in arrival order, which the probe did and which lets a late event overwrite a newer one.

import { z } from 'zod';
import type { SupporterEvent } from './events.js';

export const SupporterProjection = z.object({
  id: z.string().guid(),
  email: z.string().email(),
  firstSeen: z.string().datetime({ offset: true }),
  lastActivity: z.string().datetime({ offset: true }),
  /** Lists with confirmed consent (ADR 010 rule 5): the only lists a sender may use. */
  lists: z.array(z.string()),
  /** Lists signed up for but not yet confirmed through the double opt-in link. */
  pendingLists: z.array(z.string()),
  /** Position of the last folded event in fold order. */
  appliedThrough: z.object({ at: z.string().datetime({ offset: true }), id: z.string() }),
});
export type SupporterProjection = z.infer<typeof SupporterProjection>;

/** A point in fold order: an event's `occurred_at` and `id`. */
export interface FoldPosition {
  at: string;
  id: string;
}

/**
 * Fold order. Instants are compared as instants, not as strings, because envelopes may carry any
 * offset; ids by code unit, which matches `collate "C"` on `events.id` in Postgres.
 */
export function compareFoldPosition(a: FoldPosition, b: FoldPosition): number {
  const byTime = Date.parse(a.at) - Date.parse(b.at);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const foldPosition = (event: SupporterEvent): FoldPosition => ({
  at: new Date(event.occurred_at).toISOString(),
  id: event.id,
});

/**
 * List membership transitions. A list is in `lists` or `pendingLists`, never both: a signup for a
 * list that is already confirmed stays confirmed. `confirmed` absent on `newsletter.subscribed`
 * reads as confirmed, because the inherited Dreamkit contract published that event after its own
 * double opt-in; only this platform's forms emit `confirmed: false`.
 */
function applyLists(lists: Set<string>, pending: Set<string>, event: SupporterEvent): void {
  const list = event.props['list'];
  if (typeof list !== 'string') return;
  switch (event.type) {
    case 'newsletter.subscribed':
      if (event.props['confirmed'] === false) {
        if (!lists.has(list)) pending.add(list);
      } else {
        lists.add(list);
        pending.delete(list);
      }
      return;
    case 'consent.given':
      lists.add(list);
      pending.delete(list);
      return;
    case 'newsletter.unsubscribed':
    case 'consent.withdrawn':
      lists.delete(list);
      pending.delete(list);
      return;
    default:
      return;
  }
}

/** Fold the next event in fold order into `current`. The event must carry its `supporter_id`. */
export function applyEvent(
  current: SupporterProjection | null,
  event: SupporterEvent
): SupporterProjection {
  const position = foldPosition(event);
  const at = position.at;
  const id = current?.id ?? event.supporter_id;
  if (!id) throw new Error(`event ${event.id} has no supporter_id`);
  const base: SupporterProjection = current ?? {
    id,
    email: event.email,
    firstSeen: at,
    lastActivity: at,
    lists: [],
    pendingLists: [],
    appliedThrough: position,
  };
  const lists = new Set(base.lists);
  const pending = new Set(base.pendingLists);
  applyLists(lists, pending, event);
  const newEmail = event.props['new_email'];
  return {
    id,
    email:
      event.type === 'supporter.email_changed' && typeof newEmail === 'string'
        ? newEmail
        : base.email,
    firstSeen: at < base.firstSeen ? at : base.firstSeen,
    lastActivity: at > base.lastActivity ? at : base.lastActivity,
    lists: [...lists].sort(),
    pendingLists: [...pending].sort(),
    appliedThrough: position,
  };
}

export function rebuildProjection(events: readonly SupporterEvent[]): SupporterProjection | null {
  const ordered = [...events].sort((a, b) => compareFoldPosition(foldPosition(a), foldPosition(b)));
  return ordered.reduce<SupporterProjection | null>((p, e) => applyEvent(p, e), null);
}
