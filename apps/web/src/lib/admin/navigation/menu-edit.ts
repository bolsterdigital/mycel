// The menu editor's steps on a navigation document (ADR 036 rules 2 and 4): move a node among its
// siblings, make it a sub-item of the node above or bring it back to the top level, add, replace
// and remove nodes and menus. Pure, so the route applies one step to the revision the editor read
// and core merges the result with what was saved since (ADR 026).
//
// Two levels only: a node with sub-items and a group cannot move in, so no step can build the
// third level the schema refuses. A node that leaves the top level of the main menu leaves the
// bar selection with it, because the bar names top-level nodes (`navigationIssues`).
// Rejected: a position number per row as in the person groups (a second level would need a parent
// field too, and a typo makes a cycle), and drag and drop as the base (it cannot work without
// JavaScript; it can be laid over these steps later).

import type { Menu, NavigationChild, NavigationDocument, NavigationNode } from '@mycel/core';

export const MOVES = ['up', 'down', 'in', 'out'] as const;
export type Move = (typeof MOVES)[number];
export const PLACEMENTS = ['main', 'actions', 'footer', 'legal'] as const;
export type Placement = (typeof PLACEMENTS)[number];

type AnyNode = NavigationNode | NavigationChild;

function find(menu: Menu, nodeId: string): { top: number; child: number | null } | null {
  for (const [top, node] of menu.nodes.entries()) {
    if (node.id === nodeId) return { top, child: null };
    const child = (node.children ?? []).findIndex((c) => c.id === nodeId);
    if (child >= 0) return { top, child };
  }
  return null;
}

/** A node of the menu at either level, with whether it is a sub-item. */
export function nodeOf(menu: Menu, nodeId: string): { node: AnyNode; child: boolean } | null {
  const at = find(menu, nodeId);
  const top = at && menu.nodes[at.top];
  if (!at || !top) return null;
  if (at.child === null) return { node: top, child: false };
  const child = top.children?.[at.child];
  return child ? { node: child, child: true } : null;
}

/** The steps a node can take where it stands; the editor offers only these. */
export function movesOf(menu: Menu, nodeId: string): Move[] {
  const at = find(menu, nodeId);
  const top = at && menu.nodes[at.top];
  if (!at || !top) return [];
  const moves: Move[] = [];
  const [index, count] =
    at.child === null ? [at.top, menu.nodes.length] : [at.child, top.children?.length ?? 0];
  if (index > 0) moves.push('up');
  if (index < count - 1) moves.push('down');
  if (at.child !== null) moves.push('out');
  else if (at.top > 0 && top.kind === 'link' && !top.children?.length) moves.push('in');
  return moves;
}

const swap = <T>(list: readonly T[], i: number, j: number): T[] => {
  const next = [...list];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

const withChildren = (node: NavigationNode, children: NavigationChild[]): NavigationNode =>
  node.kind === 'group' || children.length || node.children ? { ...node, children } : node;

/** The menu after one step, or null when the node cannot take it. */
export function moveNode(menu: Menu, nodeId: string, move: Move): Menu | null {
  const at = find(menu, nodeId);
  const top = at && menu.nodes[at.top];
  if (!at || !top || !movesOf(menu, nodeId).includes(move)) return null;
  const nodes = [...menu.nodes];
  if (at.child === null) {
    if (move === 'up') return { ...menu, nodes: swap(nodes, at.top, at.top - 1) };
    if (move === 'down') return { ...menu, nodes: swap(nodes, at.top, at.top + 1) };
    // In: under the node above, as its last sub-item.
    const above = nodes[at.top - 1]!;
    if (top.kind !== 'link') return null;
    const { children: _none, ...child } = top;
    nodes[at.top - 1] = withChildren(above, [...(above.children ?? []), child]);
    nodes.splice(at.top, 1);
    return { ...menu, nodes };
  }
  const children = [...(top.children ?? [])];
  if (move === 'out') {
    const [child] = children.splice(at.child, 1);
    nodes[at.top] = withChildren(top, children);
    nodes.splice(at.top + 1, 0, child!);
    return { ...menu, nodes };
  }
  nodes[at.top] = withChildren(top, swap(children, at.child, at.child + (move === 'up' ? -1 : 1)));
  return { ...menu, nodes };
}

/** The menu without the node; a node with sub-items takes them along. */
export function removeNode(menu: Menu, nodeId: string): Menu | null {
  const at = find(menu, nodeId);
  const top = at && menu.nodes[at.top];
  if (!at || !top) return null;
  const nodes = [...menu.nodes];
  if (at.child === null) nodes.splice(at.top, 1);
  else
    nodes[at.top] = withChildren(
      top,
      (top.children ?? []).filter((c) => c.id !== nodeId)
    );
  return { ...menu, nodes };
}

/** The menu with `node` in the place of the node that has its id, at either level. */
export function replaceNode(menu: Menu, node: AnyNode): Menu | null {
  const at = find(menu, node.id);
  const top = at && menu.nodes[at.top];
  if (!at || !top) return null;
  const nodes = [...menu.nodes];
  if (at.child === null) nodes[at.top] = node as NavigationNode;
  else {
    if (node.kind !== 'link') return null;
    const { children: _none, ...child } = node as NavigationNode & { kind: 'link' };
    nodes[at.top] = withChildren(
      top,
      (top.children ?? []).map((c) => (c.id === node.id ? child : c))
    );
  }
  return { ...menu, nodes };
}

/** Where the document's draft places a menu, in placement order and without repeats. */
export function usedIn(doc: NavigationDocument, menuId: string): Placement[] {
  const { main, actions, footer, legal } = doc.placements;
  return PLACEMENTS.filter((p) =>
    p === 'footer'
      ? footer.some((f) => f.menuId === menuId)
      : (p === 'main' ? main : p === 'actions' ? actions : legal)?.menuId === menuId
  );
}

/**
 * The document with one menu changed by `edit`, or null when the menu is gone or `edit` gives
 * none. The bar keeps only what is still a top-level node of the main menu.
 */
export function editMenu(
  doc: NavigationDocument,
  menuId: string,
  edit: (menu: Menu) => Menu | null
): NavigationDocument | null {
  const menu = doc.menus.find((m) => m.id === menuId);
  const next = menu && edit(menu);
  if (!next) return null;
  const { main } = doc.placements;
  const top = new Set(next.nodes.map((n) => n.id));
  return {
    menus: doc.menus.map((m) => (m.id === menuId ? next : m)),
    placements:
      main?.menuId === menuId
        ? { ...doc.placements, main: { ...main, bar: main.bar.filter((id) => top.has(id)) } }
        : doc.placements,
  };
}

/** The document without the menu, or null while the draft still places it. */
export function removeMenu(doc: NavigationDocument, menuId: string): NavigationDocument | null {
  if (usedIn(doc, menuId).length || !doc.menus.some((m) => m.id === menuId)) return null;
  return { ...doc, menus: doc.menus.filter((m) => m.id !== menuId) };
}
