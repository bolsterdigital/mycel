// The newest revisions of the navigation (ADR 036 rule 7): each saved step is one, so the list
// says per revision when it was saved, whether it merged a change made at the same time or
// restored an older one, which is the draft and which is live where. One read of
// `site.navigation.get`, which returns the twenty newest.
import { useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const state = await loaded(runtime().invoker.run(useCases.getNavigation, locals.principal!, {}));
  const when = new Map(state.revisions.map((r) => [r.id, r.createdAt]));
  return {
    revisions: state.revisions.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      current: r.id === state.revisionId,
      merged: r.merged,
      restored: r.restoredFrom ? { at: when.get(r.restoredFrom) ?? null } : null,
      liveIn: state.publication.filter((p) => p.revisionId === r.id).map((p) => p.locale),
    })),
  };
};
