// The supporter projection (ADR 003 rule 3, ADR 019 rule 2): a fold over the supporter's log in
// `occurred_at` order with the event id as tie-break, so every arrival order of the same events
// gives the same projection. `appliedThrough` names the last event folded in; ingest applies an
// event on top only when it sorts after that point and re-folds from the log otherwise. Rejected:
// applying in arrival order, which the probe did and which lets a late event overwrite a newer one.

import { z } from 'zod';
import type { SupporterEvent } from './events.js';

/** Why access was given without a payment (ADR 016 rule 2). */
export const AccessGrantKind = z.enum(['comp', 'gift']);
export type AccessGrantKind = z.infer<typeof AccessGrantKind>;

/**
 * The supporter's standing grant for one tier: the newest `access.granted` in fold order that no
 * later `access.revoked` for that tier took back. `until` is a stored fact, never an expiry that
 * something writes: `hasAccess` compares it with the clock at each read (ADR 019 rule 4), so an
 * expired grant stays here until a revoke or a newer grant replaces it. No reason and no actor:
 * those stay in the event, and a projection is what a read route may see.
 */
export const AccessGrant = z.object({
  tierId: z.string().guid(),
  kind: AccessGrantKind,
  grantedAt: z.string().datetime({ offset: true }),
  /** Exclusive end; null is open-ended. */
  until: z.string().datetime({ offset: true }).nullable(),
});
export type AccessGrant = z.infer<typeof AccessGrant>;

export const SupporterProjection = z.object({
  id: z.string().guid(),
  email: z.string().email(),
  firstSeen: z.string().datetime({ offset: true }),
  lastActivity: z.string().datetime({ offset: true }),
  /** Lists with confirmed consent (ADR 010 rule 5): the only lists a sender may use. */
  lists: z.array(z.string()),
  /** Lists signed up for but not yet confirmed through the double opt-in link. */
  pendingLists: z.array(z.string()),
  /** One standing grant per tier, by tier id (ADR 016 rule 2). */
  grants: z.array(AccessGrant).default([]),
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

/**
 * Grant transitions, one grant per tier: a later grant replaces the earlier one (so a grant can
 * be extended or shortened by granting again), a revoke removes it. An event whose props no
 * longer name a tier (an erased supporter's events have empty props) changes nothing, so a
 * re-fold after an erasure leaves no grant. Rejected: a list of every grant ever given, which
 * would make the projection a second log and `hasAccess` a search through history.
 */
function applyGrants(grants: Map<string, AccessGrant>, event: SupporterEvent, at: string): void {
  if (event.type !== 'access.granted' && event.type !== 'access.revoked') return;
  const tierId = z.string().guid().safeParse(event.props['tier_id']);
  if (!tierId.success) return;
  if (event.type === 'access.revoked') {
    grants.delete(tierId.data);
    return;
  }
  const kind = AccessGrantKind.safeParse(event.props['kind']);
  const until = event.props['until'];
  // Fail closed: a grant whose kind or end cannot be read is no grant.
  if (!kind.success) return;
  if (until !== undefined && until !== null) {
    if (typeof until !== 'string' || Number.isNaN(Date.parse(until))) return;
  }
  grants.set(tierId.data, {
    tierId: tierId.data,
    kind: kind.data,
    grantedAt: at,
    until: typeof until === 'string' ? new Date(until).toISOString() : null,
  });
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
    grants: [],
    appliedThrough: position,
  };
  const lists = new Set(base.lists);
  const pending = new Set(base.pendingLists);
  applyLists(lists, pending, event);
  const grants = new Map((base.grants ?? []).map((g) => [g.tierId, g]));
  applyGrants(grants, event, at);
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
    grants: [...grants.values()].sort((a, b) => (a.tierId < b.tierId ? -1 : 1)),
    appliedThrough: position,
  };
}

export function rebuildProjection(events: readonly SupporterEvent[]): SupporterProjection | null {
  const ordered = [...events].sort((a, b) => compareFoldPosition(foldPosition(a), foldPosition(b)));
  return ordered.reduce<SupporterProjection | null>((p, e) => applyEvent(p, e), null);
}
