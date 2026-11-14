// The navigation screen (ADR 036, brief site-navigation § 3 and § 5): per language what is live
// and where the draft stands, where the draft places its menus, and the menus themselves with
// where each is used. It starts with the menus and their use, not with settings; a menu is opened
// to edit it, a language to preview and publish it. `site.navigation.get` decides who may see it.
import { can, menuNodes, useCases } from '@mycel/core';
import { PLACEMENTS, usedIn } from '#lib/admin/navigation/menu-edit.js';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { localeStates } from '#lib/server/navigation/publication.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  const { tenant } = await parent();
  const principal = locals.principal!;
  const state = await loaded(runtime().invoker.run(useCases.getNavigation, principal, {}));
  const { document } = state;
  const name = (id: string) => document.menus.find((m) => m.id === id)?.name ?? id;
  const { main, actions, footer, legal } = document.placements;
  const placed = {
    main: main && [main],
    actions: actions && [actions],
    footer,
    legal: legal && [legal],
  };
  return {
    menus: document.menus.map((menu) => ({
      id: menu.id,
      name: menu.name,
      items: menuNodes(menu).length,
      usedIn: usedIn(document, menu.id),
    })),
    placements: PLACEMENTS.map((key) => ({
      key,
      menus: (placed[key] ?? []).map((p) => ({ id: p.menuId, name: name(p.menuId) })),
    })),
    locales: await localeStates(principal, state, tenant.locales),
    revisions: state.revisions.length,
    canWrite: can(principal, 'content:write'),
  };
};
