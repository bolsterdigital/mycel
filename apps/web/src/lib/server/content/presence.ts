// What the edit screen shows of `content.presence.*` (ADR 029): labels in place of actors, so the
// page and the beat answer alike and nothing else of a principal reaches the browser.
import { PRESENCE_BEAT_MS, useCases, type Principal, type PresenceView } from '@mycel/core';
import { actorLabel } from '#lib/server/content/content-admin.js';
import { runtime } from '#lib/server/runtime.js';

export interface PresenceLines {
  present: { who: string; state: 'viewing' | 'editing'; self: boolean }[];
  newer: { who: string } | null;
}

export const presenceLines = (view: PresenceView): PresenceLines => ({
  present: view.present.map((p) => ({ who: actorLabel(p.actor), state: p.state, self: p.self })),
  newer: view.newer ? { who: actorLabel(view.newer.actor) } : null,
});

/**
 * The first render, also without JavaScript. The asker's own lines are left out: before the first
 * beat this tab cannot tell itself from a tab it replaced a moment ago by reloading.
 */
export async function presenceOnLoad(
  principal: Principal,
  tenantSlug: string,
  itemId: string,
  base: string
) {
  const view = await runtime().invoker.run(useCases.listPresence, principal, { itemId });
  const { present, newer } = presenceLines(view);
  return {
    present: present.filter((p) => !p.self),
    newer,
    beatMs: PRESENCE_BEAT_MS,
    endpoint: `/admin/${tenantSlug}/content/${itemId}/presence`,
    base,
  };
}
