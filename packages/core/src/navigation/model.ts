// The site navigation document (ADR 036 rules 1 to 4 and 6): every menu of a tenant and the
// placements that show them, as one aggregate that is saved, merged and published whole. A menu
// is a tree of at most two levels; a node is a link with a closed-union target or a group with a
// label. The schema refuses a third level by construction (a child has no `children`), so a
// deeper tree is invalid input, never flattened; `navigationIssues` checks what a schema cannot:
// unique ids, budgets and placements that name real menus and nodes.
//
// Ids are block-id shaped strings, so `mergeDocuments` (ADR 026) merges menus and nodes per id at
// every depth and two editors only conflict on the same menu's order, the same label or the same
// placement. Rejected: parent pointers on a flat node list (cycles and unknown parents become
// possible and need checking on every save), and a map of menus by id (the order of menus in the
// admin would be lost, and a map has no order value to merge).

import { z } from 'zod';
import type { Issue } from '../errors.js';
import { Locale } from '../i18n/locale.js';
import { SiteHref } from '../theme/settings.js';

/** A stable id of a menu or node: the block-id alphabet, so merge paths and refs can carry it. */
export const NavigationId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'site.navigation.id.invalid');

/** A localised label; a locale without a value has none (inherit, or an empty group label). */
export const NavigationLabel = z.record(Locale, z.string().trim().min(1).max(120));
export type NavigationLabel = z.infer<typeof NavigationLabel>;

/** ADR 036 rule 3: content by id (an optional block id as anchor), a URL, or a platform page. */
export const NavigationTarget = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('content'),
      itemId: z.string().guid(),
      anchor: NavigationId.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('url'), href: SiteHref }).strict(),
  z.object({ kind: z.literal('system'), page: z.enum(['home', 'search']) }).strict(),
]);
export type NavigationTarget = z.infer<typeof NavigationTarget>;

const ChildLink = z
  .object({
    id: NavigationId,
    kind: z.literal('link'),
    target: NavigationTarget,
    label: NavigationLabel.optional(),
  })
  .strict();

/** A top-level node; only these may have children (rule 2). */
export const NavigationNode = z.discriminatedUnion('kind', [
  z
    .object({
      id: NavigationId,
      kind: z.literal('link'),
      target: NavigationTarget,
      label: NavigationLabel.optional(),
      children: z.array(ChildLink).optional(),
    })
    .strict(),
  z
    .object({
      id: NavigationId,
      kind: z.literal('group'),
      label: NavigationLabel,
      children: z.array(ChildLink),
    })
    .strict(),
]);
export type NavigationNode = z.infer<typeof NavigationNode>;
export type NavigationChild = z.infer<typeof ChildLink>;

export const NAVIGATION_BUDGET = {
  menus: 20,
  nodesPerMenu: 100,
  nodesPerSite: 500,
  actions: 2,
  footerColumns: 4,
} as const;

export const Menu = z
  .object({
    id: NavigationId,
    /** An internal name for the admin; never shown to visitors. */
    name: z.string().trim().min(1).max(80),
    nodes: z.array(NavigationNode),
  })
  .strict();
export type Menu = z.infer<typeof Menu>;

/** ADR 036 rule 4: a closed set of placements; search and the language switch are utilities. */
export const Placements = z
  .object({
    main: z
      .object({ menuId: NavigationId, bar: z.array(NavigationId) })
      .strict()
      .nullable(),
    actions: z.object({ menuId: NavigationId }).strict().nullable(),
    footer: z.array(z.object({ menuId: NavigationId, title: NavigationLabel.optional() }).strict()),
    legal: z.object({ menuId: NavigationId }).strict().nullable(),
  })
  .strict();
export type Placements = z.infer<typeof Placements>;

export const NavigationDocument = z
  .object({ menus: z.array(Menu), placements: Placements })
  .strict();
export type NavigationDocument = z.infer<typeof NavigationDocument>;

export const EMPTY_NAVIGATION: NavigationDocument = {
  menus: [],
  placements: { main: null, actions: null, footer: [], legal: null },
};

/** Every node of a menu, top level first, each child after its parent. */
export function menuNodes(menu: Menu): (NavigationNode | NavigationChild)[] {
  return menu.nodes.flatMap((n) => [n, ...(n.children ?? [])]);
}

/** The menus the placements show, in placement order and without repeats. */
export function placedMenuIds(placements: Placements): string[] {
  const ids = [
    placements.main?.menuId,
    placements.actions?.menuId,
    ...placements.footer.map((f) => f.menuId),
    placements.legal?.menuId,
  ].filter((id): id is string => id !== undefined);
  return [...new Set(ids)];
}

/** One row of `site_navigation_refs` (0056): a menu that targets a content item. */
export interface NavigationReference {
  menuId: string;
  itemId: string;
}

/** The content targets of a document, one per menu and item (ADR 036 rule 9). */
export function navigationReferences(doc: NavigationDocument): NavigationReference[] {
  const seen = new Set<string>();
  const out: NavigationReference[] = [];
  for (const menu of doc.menus)
    for (const node of menuNodes(menu)) {
      if (node.kind !== 'link' || node.target.kind !== 'content') continue;
      const key = `${menu.id} ${node.target.itemId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ menuId: menu.id, itemId: node.target.itemId });
    }
  return out;
}

/**
 * What the schema cannot check (rules 2 and 4): unique ids, the budgets, and placements that name
 * menus and nodes of this document. Empty when the document may be saved. Locale readiness and
 * target existence are checked elsewhere: they depend on the site, not on the document alone.
 */
export function navigationIssues(doc: NavigationDocument): Issue[] {
  const issues: Issue[] = [];
  const issue = (path: string, message: string, params?: Record<string, string>) =>
    issues.push(params ? { path, message, params } : { path, message });
  const B = NAVIGATION_BUDGET;

  if (doc.menus.length > B.menus)
    issue('menus', 'site.navigation.budget.menus', { max: String(B.menus) });
  const menuIds = new Set<string>();
  const nodeIds = new Set<string>();
  let total = 0;
  doc.menus.forEach((menu, m) => {
    if (menuIds.has(menu.id)) issue(`menus.${m}.id`, 'site.navigation.menu.duplicate');
    menuIds.add(menu.id);
    const nodes = menuNodes(menu);
    total += nodes.length;
    if (nodes.length > B.nodesPerMenu)
      issue(`menus.${m}.nodes`, 'site.navigation.budget.nodes', { max: String(B.nodesPerMenu) });
    menu.nodes.forEach((node, n) => {
      const paths = [
        [node, `menus.${m}.nodes.${n}`] as const,
        ...(node.children ?? []).map((c, k) => [c, `menus.${m}.nodes.${n}.children.${k}`] as const),
      ];
      // A repeated id is also the only way to express a cycle in a nested tree.
      for (const [x, path] of paths) {
        if (nodeIds.has(x.id)) issue(`${path}.id`, 'site.navigation.node.duplicate');
        nodeIds.add(x.id);
      }
    });
  });
  if (total > B.nodesPerSite)
    issue('menus', 'site.navigation.budget.site', { max: String(B.nodesPerSite) });

  const menu = (id: string) => doc.menus.find((x) => x.id === id);
  const known = (id: string, path: string) => {
    const found = menu(id);
    if (!found) issue(path, 'site.navigation.placement.unknown-menu');
    return found;
  };
  const { main, actions, footer, legal } = doc.placements;
  if (main) {
    const placed = known(main.menuId, 'placements.main.menuId');
    const top = new Set(placed?.nodes.map((n) => n.id));
    main.bar.forEach((id, i) => {
      if (placed && !top.has(id))
        issue(`placements.main.bar.${i}`, 'site.navigation.placement.unknown-node');
    });
    if (new Set(main.bar).size !== main.bar.length)
      issue('placements.main.bar', 'site.navigation.placement.duplicate-node');
  }
  if (actions) {
    const placed = known(actions.menuId, 'placements.actions.menuId');
    // Two calls to action at most, each a link: a group cannot be a button (rule 4).
    if (
      placed &&
      (menuNodes(placed).length > B.actions ||
        placed.nodes.some((n) => n.kind !== 'link' || n.children?.length))
    )
      issue('placements.actions', 'site.navigation.placement.actions', { max: String(B.actions) });
  }
  if (footer.length > B.footerColumns)
    issue('placements.footer', 'site.navigation.budget.footer', { max: String(B.footerColumns) });
  footer.forEach((f, i) => known(f.menuId, `placements.footer.${i}.menuId`));
  if (legal) known(legal.menuId, 'placements.legal.menuId');
  return issues;
}
