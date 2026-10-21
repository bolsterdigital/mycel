// The supporter projection (ADR 003 rule 3): derived from the event log only, deterministically,
// so `rebuildProjection(events)` always equals applying the same events one by one in order.

import { z } from 'zod';
import type { SupporterEvent } from './events.js';

export const SupporterProjection = z.object({
  email: z.string().email(),
  firstSeen: z.string().datetime({ offset: true }),
  lastActivity: z.string().datetime({ offset: true }),
  /**
   * Lists this person signed up for. In the probe a signup counts before double opt-in is
   * confirmed; the confirmed/pending split arrives with `consent.given` (follow-up).
   */
  lists: z.array(z.string()),
});
export type SupporterProjection = z.infer<typeof SupporterProjection>;

export function applyEvent(
  current: SupporterProjection | null,
  event: SupporterEvent
): SupporterProjection {
  const at = new Date(event.occurred_at).toISOString();
  const base: SupporterProjection = current ?? {
    email: event.email,
    firstSeen: at,
    lastActivity: at,
    lists: [],
  };
  const lists = new Set(base.lists);
  const list = event.props['list'];
  if (event.type === 'newsletter.subscribed' && typeof list === 'string') lists.add(list);
  if (event.type === 'newsletter.unsubscribed' && typeof list === 'string') lists.delete(list);
  return {
    email: base.email,
    firstSeen: at < base.firstSeen ? at : base.firstSeen,
    lastActivity: at > base.lastActivity ? at : base.lastActivity,
    lists: [...lists].sort(),
  };
}

export function rebuildProjection(events: readonly SupporterEvent[]): SupporterProjection | null {
  const ordered = [...events].sort((a, b) =>
    a.occurred_at === b.occurred_at
      ? a.id.localeCompare(b.id)
      : a.occurred_at < b.occurred_at
        ? -1
        : 1
  );
  return ordered.reduce<SupporterProjection | null>((p, e) => applyEvent(p, e), null);
}
