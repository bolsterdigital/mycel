// The placements of the navigation draft (ADR 036 rule 4, brief site-navigation § 3): which menu
// is the main navigation and which of its items stand in the bar, the action buttons, the footer
// columns and the legal links. One form, one save through `saveNavigation` on the revision the
// form was loaded with, so core merges it per placement with what was saved since.
import { can, useCases } from '@mycel/core';
import {
  formOf,
  placementsFrom,
  postedForm,
  type PlacementsForm,
} from '#lib/admin/navigation/placements.js';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { saveNavigation } from '#lib/server/navigation/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { contentLocale } = await parent();
  const principal = locals.principal!;
  if (!can(principal, 'content:write')) refuse(403);
  const { invoker } = runtime();
  const state = await loaded(invoker.run(useCases.getNavigation, principal, {}));
  const { main } = state.document.placements;
  const placed = main && state.document.menus.find((m) => m.id === main.menuId);
  const { nodes } = placed
    ? await loaded(
        invoker.run(useCases.checkNavigation, principal, {
          locale: contentLocale,
          revisionId: state.revisionId!,
        })
      )
    : { nodes: [] };
  const check = new Map(nodes.map((n) => [n.nodeId, n]));
  return {
    baseRevisionId: state.revisionId,
    menus: state.document.menus.map((m) => ({ value: m.id, label: m.name })),
    form: formOf(state.document.placements, contentLocale),
    /**
     * The top-level items of the placed main menu with their text in the content locale, and
     * whether their page is not shown there (members only, unpublished, gone): a members-only
     * page has a title, but visitors do not read it.
     */
    bar: placed
      ? {
          menu: placed.name,
          items: placed.nodes.map((n) => ({
            id: n.id,
            label: check.get(n.id)?.label ?? null,
            state: check.get(n.id)?.target ?? null,
            system: n.kind === 'link' && n.target.kind === 'system' ? n.target.page : null,
          })),
        }
      : null,
  };
};

/** What the form posted, in the shape `placementsFrom` reads. */
const posted = (data: FormData): PlacementsForm =>
  postedForm(
    Object.fromEntries([...data].flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])))
  );

export const actions: Actions = {
  default: (event) =>
    saveNavigation(
      event,
      'placements',
      (doc, data, locale) => {
        const placements = placementsFrom(doc, posted(data), locale);
        return placements ? { ...doc, placements } : 'admin.navigation.error.conflict';
      },
      () => ''
    ),
};
