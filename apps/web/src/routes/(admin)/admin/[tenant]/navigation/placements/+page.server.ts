// The placements of the navigation draft (ADR 036 rule 4, brief site-navigation § 3): which menu
// is the main navigation and which of its items stand in the bar, the action buttons, the footer
// columns and the legal links. One form, one save through `saveNavigation` on the revision the
// form was loaded with, so core merges it per placement with what was saved since.
import { can, useCases } from '@mycel/core';
import {
  FOOTER_SLOTS,
  formOf,
  placementsFrom,
  type PlacementsForm,
} from '#lib/admin/navigation/placements.js';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
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
  const label = new Map(nodes.map((n) => [n.nodeId, n.label]));
  return {
    baseRevisionId: state.revisionId,
    menus: state.document.menus.map((m) => ({ value: m.id, label: m.name })),
    form: formOf(state.document.placements, contentLocale),
    /** The top-level items of the placed main menu, with what visitors read in the content locale. */
    bar: placed
      ? {
          menu: placed.name,
          items: placed.nodes.map((n) => ({
            id: n.id,
            label: label.get(n.id) ?? null,
            system: n.kind === 'link' && n.target.kind === 'system' ? n.target.page : null,
          })),
        }
      : null,
  };
};

/** What the form posted, in the shape `placementsFrom` reads. */
function posted(data: FormData): PlacementsForm {
  return {
    main: text(data, 'main'),
    bar: text(data, 'barShown')
      ? [...data.keys()].filter((k) => k.startsWith('bar:')).map((k) => k.slice(4))
      : null,
    actions: text(data, 'actions'),
    footer: Array.from({ length: FOOTER_SLOTS }, (_, i) => ({
      menuId: text(data, `footer${i}`),
      title: text(data, `footer${i}Title`),
    })),
    legal: text(data, 'legal'),
  };
}

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
