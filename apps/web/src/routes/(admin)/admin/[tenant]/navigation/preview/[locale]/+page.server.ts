// The preview of the navigation draft in one locale, and its publication there (ADR 036 rule 7,
// brief site-navigation § 5): what visitors would get, what is left out and why, which version is
// live, and the controls to publish this revision or take the locale offline. An anchor on a part
// that shows nothing on the site now is listed with the rest (`anchors.ts`). Reading needs what
// the draft needs (`content:read`); the controls are there only for `content:publish`, and core
// refuses anyone else all the same.
import { can, useCases } from '@mycel/core';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { emptyAnchors } from '#lib/server/navigation/anchors.js';
import { previewModel, publicationStep, revisionOf } from '#lib/server/navigation/publication.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { tenant } = await parent();
  const locale = params.locale;
  if (!tenant.locales.includes(locale)) refuse(404);
  const principal = locals.principal!;
  const { invoker } = runtime();
  const state = await loaded(invoker.run(useCases.getNavigation, principal, {}));
  const check = await loaded(
    invoker.run(useCases.checkNavigation, principal, {
      locale,
      ...(state.revisionId ? { revisionId: state.revisionId } : {}),
    })
  );
  const live = state.publication.find((p) => p.locale === locale) ?? null;
  const empty = await emptyAnchors(principal.tenantId, state.document, check.preview, locale);
  return {
    previewLocale: locale,
    revisionId: state.revisionId,
    live,
    ahead: !!state.revisionId && live?.revisionId !== state.revisionId,
    ...previewModel(state.document, check, locale, tenant.defaultLocale, empty),
    canPublish: can(principal, 'content:publish'),
  };
};

export const actions: Actions = {
  publish: (event) =>
    publicationStep(
      event,
      'publish',
      (principal, data) =>
        runtime().invoker.run(useCases.publishNavigation, principal, {
          revisionId: revisionOf(data),
          locale: event.params.locale,
        }),
      `/preview/${event.params.locale}`,
      'published'
    ),
  unpublish: (event) =>
    publicationStep(
      event,
      'unpublish',
      (principal) =>
        runtime().invoker.run(useCases.unpublishNavigation, principal, {
          locale: event.params.locale,
        }),
      `/preview/${event.params.locale}`,
      'offline'
    ),
};
