// One item of a menu (brief site-navigation § 3): a link to a page or article, an address, the
// home page or the search page, with an optional menu text of its own; or a group, which is only
// a text above its sub-items. `new` adds one at the end of the menu (`?kind=group` for a group);
// an id edits that node where it stands, sub-items and the other locales' texts kept.
import { can, useCases } from '@mycel/core';
import { editMenu, nodeOf, replaceNode } from '#lib/admin/navigation/menu-edit.js';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { newId, nodeFromForm, saveNavigation, targetItems } from '#lib/server/navigation/admin.js';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params, url }) => {
  const { contentLocale } = await parent();
  const principal = locals.principal!;
  if (!can(principal, 'content:write')) refuse(403);
  const { invoker } = runtime();
  const state = await loaded(invoker.run(useCases.getNavigation, principal, {}));
  const menu = state.document.menus.find((m) => m.id === params.menuId);
  if (!menu) refuse(404);
  const found = params.nodeId === 'new' ? null : nodeOf(menu, params.nodeId);
  if (params.nodeId !== 'new' && !found) refuse(404);
  const node = found?.node ?? null;
  const kind = node?.kind ?? (url.searchParams.get('kind') === 'group' ? 'group' : 'link');
  const target = node?.kind === 'link' ? node.target : null;
  const [check, items] = await Promise.all([
    node
      ? loaded(invoker.run(useCases.checkNavigation, principal, { locale: contentLocale })).then(
          ({ nodes }) => nodes.find((n) => n.menuId === menu.id && n.nodeId === node.id) ?? null
        )
      : null,
    kind === 'link'
      ? targetItems(principal, target?.kind === 'content' ? [target.itemId] : [], contentLocale)
      : [],
  ]);
  return {
    baseRevisionId: state.revisionId,
    menu: { id: menu.id, name: menu.name },
    nodeId: node?.id ?? null,
    kind,
    items,
    values: {
      label: node?.label?.[contentLocale] ?? '',
      target:
        target?.kind === 'content'
          ? target.itemId
          : target?.kind === 'system'
            ? target.page
            : target?.kind === 'url'
              ? 'url'
              : '',
      url: target?.kind === 'url' ? target.href : '',
    },
    /** What the link shows without a text of its own: the target's published title, if any. */
    inherited: check && check.source !== 'own' ? check.label : null,
  };
};

export const actions: Actions = {
  default: (event) => {
    const { menuId = '', nodeId = '' } = event.params;
    return saveNavigation(
      event,
      'save',
      (doc, data, locale) => {
        const menu = doc.menus.find((m) => m.id === menuId);
        if (!menu) return 'admin.navigation.error.conflict';
        if (nodeId === 'new') {
          const node = nodeFromForm(
            data,
            locale,
            text(data, 'kind') === 'group' ? 'group' : 'link',
            newId(),
            null
          );
          if (typeof node === 'string') return node;
          return (
            editMenu(doc, menuId, (m) => ({ ...m, nodes: [...m.nodes, node] })) ??
            'admin.navigation.error.conflict'
          );
        }
        const current = nodeOf(menu, nodeId)?.node;
        if (!current) return 'admin.navigation.error.conflict';
        const node = nodeFromForm(data, locale, current.kind, current.id, current);
        if (typeof node === 'string') return node;
        return (
          editMenu(doc, menuId, (m) => replaceNode(m, node)) ?? 'admin.navigation.error.conflict'
        );
      },
      () => `/${menuId}`
    );
  },
};
