// The publication side of the menu editor (ADR 036 rule 7, brief site-navigation § 5): per locale
// which revision is live and whether the draft is ahead or cannot be published yet, the preview
// of a revision in a locale with what it leaves out, and the three commands that are not a save
// of the draft: publish a locale, take it offline, restore an older revision as the draft.
//
// Every read goes through `site.navigation.check`, the same function `site.navigation.publish`
// validates with, so "blocks publication" here is exactly what publishing refuses. Publishing
// names the revision the preview showed, not whatever is latest when the button is pressed: an
// editor publishes what they looked at, and a newer draft stays a draft. Who may publish is
// core's decision; the screen only leaves out a control the principal would be refused.
// Rejected: comparing documents to decide "ahead" (a read of every published revision per page
// for the rare restore of an identical document), and publishing the latest revision (a save in
// another window between preview and click would go live unseen).

import { useCases, type NavigationDocument, type Principal } from '@mycel/core';
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { previewOf } from '#lib/admin/navigation/preview.js';
import { failureOf, text, type ActionCopy } from '../admin/admin-actions.js';
import { requireTenantPrincipal } from '../admin/admin.js';
import { refusalOf } from '../http/refuse.js';
import { runtime } from '../runtime.js';

type State = Awaited<ReturnType<(typeof useCases.getNavigation)['handler']>>;
type Check = Awaited<ReturnType<(typeof useCases.checkNavigation)['handler']>>;

export interface LocaleState {
  locale: string;
  /** The live revision of the locale; null when it publishes no navigation. */
  live: { revisionId: string; publishedAt: string } | null;
  /**
   * Where the draft stands: `same` when it is the live revision (or there is none at all),
   * `ahead` when it is another one that may be published, `blocked` when it is another one that
   * something refuses.
   */
  draft: 'same' | 'ahead' | 'blocked';
}

/**
 * Per locale of the site, what is live and where the draft stands; one check per locale whose
 * draft is ahead. A draft that is live has nothing to publish: a target that went offline since
 * makes it "cannot be published" only for a new revision, so it stays `same` (the preview still
 * lists what no longer shows). Rejected: checking every locale and letting `blocked` win, which
 * told an editor whose live menu lost a page that the menu "cannot be published yet".
 */
export async function localeStates(
  principal: Principal,
  state: State,
  locales: readonly string[]
): Promise<LocaleState[]> {
  const { invoker } = runtime();
  const draft = state.revisionId;
  return Promise.all(
    locales.map(async (locale): Promise<LocaleState> => {
      const live = state.publication.find((p) => p.locale === locale) ?? null;
      const shown = live && { revisionId: live.revisionId, publishedAt: live.publishedAt };
      if (!draft || live?.revisionId === draft) return { locale, live: shown, draft: 'same' };
      const check = await invoker.run(useCases.checkNavigation, principal, {
        locale,
        revisionId: draft,
      });
      const blocked = check.problems.some((p) => p.blocking);
      return { locale, live: shown, draft: blocked ? 'blocked' : 'ahead' };
    })
  );
}

export interface ProblemRow {
  menu: string;
  /** The item's text in the locale; null when it has none there. */
  item: string | null;
  /** Core's problems, and `anchor-empty`: the anchor's part shows nothing on the site now. */
  code: Check['problems'][number]['code'] | 'anchor-empty';
  blocking: boolean;
}

/** A revision as visitors in `locale` would get it, and what it leaves out, named for people. */
export function previewModel(
  document: NavigationDocument,
  check: Check,
  locale: string,
  defaultLocale: string,
  emptyAnchors: readonly { menuId: string; nodeId: string }[] = []
) {
  const menus = Object.fromEntries(document.menus.map((m) => [m.id, m.name]));
  const label = new Map(check.nodes.map((n) => [`${n.menuId} ${n.nodeId}`, n.label]));
  const problems: ProblemRow[] = [
    ...check.problems,
    ...emptyAnchors.map((a) => ({ ...a, code: 'anchor-empty' as const, blocking: false })),
  ].map((p) => ({
    menu: menus[p.menuId] ?? p.menuId,
    item: label.get(`${p.menuId} ${p.nodeId}`) ?? null,
    code: p.code,
    blocking: p.blocking,
  }));
  return {
    menus,
    preview: previewOf(document, check.preview, locale, defaultLocale),
    problems,
    blocked: problems.some((p) => p.blocking),
  };
}

const COPY: ActionCopy = {
  conflict: 'admin.navigation.error.conflict',
  invalid: 'admin.navigation.error.publish',
  notFound: 'admin.navigation.error.revisionGone',
};

/**
 * Run one publication command for the form that posted it, then show `to` (below the navigation
 * screen) with `done` in the query; a refusal comes back as a form failure.
 */
export async function publicationStep(
  event: RequestEvent,
  action: string,
  run: (principal: Principal, data: FormData) => Promise<unknown>,
  to: string,
  done: string
) {
  const { principal, tenant } = await requireTenantPrincipal(
    event.locals,
    event.url,
    event.params['tenant']!
  );
  const data = await event.request.formData();
  try {
    await run(principal, data);
  } catch (e) {
    const { status, body } = failureOf(refusalOf(e), action, COPY);
    return fail(status, body);
  }
  redirect(303, `/admin/${tenant.slug}/navigation${to}?${done}=1`);
}

/** The revision a form names, as posted. */
export const revisionOf = (data: FormData): string => text(data, 'revisionId');
