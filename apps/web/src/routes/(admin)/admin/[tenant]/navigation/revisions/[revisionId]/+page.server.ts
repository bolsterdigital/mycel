// One revision of the navigation (ADR 036 rule 7): what it shows visitors in the content locale,
// resolved against the pages as they are published now, and the restore that copies it into a new
// draft on the revision this page was loaded with. Restoring needs `content:write` and publishes
// nothing.
import { can, useCases } from '@mycel/core';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
import { previewModel, publicationStep, revisionOf } from '#lib/server/navigation/publication.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { tenant, contentLocale } = await parent();
  const principal = locals.principal!;
  const { invoker } = runtime();
  const revisionId = params.revisionId;
  const [state, check] = await Promise.all([
    loaded(invoker.run(useCases.getNavigation, principal, { revisionId })),
    loaded(invoker.run(useCases.checkNavigation, principal, { locale: contentLocale, revisionId })),
  ]);
  const summary = state.revisions.find((r) => r.id === revisionId);
  const latest = state.revisions[0]?.id ?? null;
  return {
    revisionId,
    createdAt: summary?.createdAt ?? null,
    current: revisionId === latest,
    baseRevisionId: latest,
    liveIn: state.publication.filter((p) => p.revisionId === revisionId).map((p) => p.locale),
    ...previewModel(state.document, check, contentLocale, tenant.defaultLocale),
    canWrite: can(principal, 'content:write'),
  };
};

export const actions: Actions = {
  restore: (event) =>
    publicationStep(
      event,
      'restore',
      (principal, data) =>
        runtime().invoker.run(useCases.restoreNavigation, principal, {
          revisionId: revisionOf(data),
          baseRevisionId: text(data, 'baseRevisionId'),
        }),
      '',
      'restored'
    ),
};
