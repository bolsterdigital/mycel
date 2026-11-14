// One menu of the navigation draft (brief site-navigation § 3): its items in order with what each
// shows visitors in the content locale, the steps that order and nest them, its name, and its
// removal. `new` is the form that makes a menu. Every action is one save through
// `saveNavigation`, on the revision this page was loaded with.
import { can, useCases, type NavigationDocument } from '@mycel/core';
import {
  MOVES,
  editMenu,
  moveNode,
  removeMenu,
  removeNode,
  usedIn,
  type Move,
} from '#lib/admin/navigation/menu-edit.js';
import { loaded, text } from '#lib/server/admin/admin-actions.js';
import { refuse } from '#lib/server/http/refuse.js';
import { menuRows, newId, saveNavigation, targetItems } from '#lib/server/navigation/admin.js';
import { targetIds } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ parent, locals, params }) => {
  const { contentLocale } = await parent();
  const principal = locals.principal!;
  const { invoker } = runtime();
  const canWrite = can(principal, 'content:write');
  const state = await loaded(invoker.run(useCases.getNavigation, principal, {}));
  if (params.menuId === 'new') {
    if (!canWrite) refuse(403);
    return { baseRevisionId: state.revisionId, menu: null, rows: [], usedIn: [], canWrite };
  }
  const menu = state.document.menus.find((m) => m.id === params.menuId);
  if (!menu) refuse(404);
  const [{ nodes }, items] = await Promise.all([
    loaded(invoker.run(useCases.checkNavigation, principal, { locale: contentLocale })),
    targetItems(principal, targetIds({ ...state.document, menus: [menu] }), contentLocale),
  ]);
  return {
    baseRevisionId: state.revisionId,
    menu: { id: menu.id, name: menu.name },
    rows: menuRows(menu, nodes, items),
    usedIn: usedIn(state.document, menu.id),
    canWrite,
  };
};

const name = (data: FormData) => text(data, 'name').trim().slice(0, 80);
const gone = 'admin.navigation.error.conflict' as const;

export const actions: Actions = {
  create: (event) => {
    const id = newId();
    return saveNavigation(
      event,
      'create',
      (doc, data): NavigationDocument | 'admin.navigation.error.nameRequired' =>
        name(data)
          ? { ...doc, menus: [...doc.menus, { id, name: name(data), nodes: [] }] }
          : 'admin.navigation.error.nameRequired',
      () => `/${id}`
    );
  },
  rename: (event) =>
    saveNavigation(
      event,
      'rename',
      (doc, data) =>
        name(data)
          ? (editMenu(doc, event.params['menuId']!, (m) => ({ ...m, name: name(data) })) ?? gone)
          : 'admin.navigation.error.nameRequired',
      () => `/${event.params['menuId']}`
    ),
  move: (event) =>
    saveNavigation(
      event,
      'move',
      (doc, data) => {
        const [nodeId = '', move = ''] = text(data, 'step').split('|');
        if (!(MOVES as readonly string[]).includes(move)) return gone;
        return (
          editMenu(doc, event.params['menuId']!, (m) => moveNode(m, nodeId, move as Move)) ?? gone
        );
      },
      () => `/${event.params['menuId']}`
    ),
  remove: (event) =>
    saveNavigation(
      event,
      'remove',
      (doc, data) =>
        editMenu(doc, event.params['menuId']!, (m) => removeNode(m, text(data, 'nodeId'))) ?? gone,
      () => `/${event.params['menuId']}`
    ),
  delete: (event) =>
    saveNavigation(
      event,
      'delete',
      (doc) => removeMenu(doc, event.params['menuId']!) ?? 'admin.navigation.error.menuPlaced',
      () => ''
    ),
};
