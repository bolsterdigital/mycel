// The navigation screen (ADR 036, brief site-navigation § 3): the menus of the site's draft and
// where the draft uses each. It starts with the menus, not with settings; a menu is opened to
// edit it. One read of `site.navigation.get`, which also decides who may see it.
import { can, menuNodes, useCases } from '@mycel/core';
import { usedIn } from '#lib/admin/navigation/menu-edit.js';
import { loaded } from '#lib/server/admin/admin-actions.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals }) => {
  await parent();
  const principal = locals.principal!;
  const { document } = await loaded(runtime().invoker.run(useCases.getNavigation, principal, {}));
  return {
    menus: document.menus.map((menu) => ({
      id: menu.id,
      name: menu.name,
      items: menuNodes(menu).length,
      usedIn: usedIn(document, menu.id),
    })),
    canWrite: can(principal, 'content:write'),
  };
};
