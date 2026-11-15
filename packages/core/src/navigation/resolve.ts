// Public resolution of a navigation document in one locale (ADR 036 rules 5, 6 and 8). Pure: the
// caller reads the published targets in one batch (`NavigationRepository.publishedTargets`) and
// passes them in, so the memory and Postgres adapters resolve alike and there is no N+1.
//
// The label of a node is its own text in the locale, else the target's published featured title,
// else its published title, in that locale; nothing else. A target that is not published publicly
// in the locale renders nothing. A link with children whose target disappeared keeps its children
// as a group only with its own label; otherwise the branch goes and `problems` names the children
// that became unreachable. Paths of content targets are built by the front (`contentPath` needs
// the site's default locale, and `searchPath` lives in the web app): core returns the target.
//
// `i18n.fallback` (ADR 018 rule 9) does not exist in code yet, so a missing locale is not replaced
// by another; when the setting lands, the fallback locale is a second `publishedTargets` read.

import type { ContentType } from '../content/model.js';
import { menuNodes, placedMenuIds } from './model.js';
import type { Menu, NavigationDocument, NavigationNode } from './model.js';
import type { PublishedTarget } from './ports.js';

export type ResolvedTarget =
  | {
      kind: 'content';
      itemId: string;
      type: ContentType;
      slug: string;
      locale: string;
      anchor?: string;
    }
  | { kind: 'url'; href: string }
  | { kind: 'system'; page: 'home' | 'search' };

/** A link's label is null only for a system target without its own label: the front names it. */
export interface ResolvedLink {
  id: string;
  kind: 'link';
  label: string | null;
  target: ResolvedTarget;
}

export type ResolvedNode =
  | (ResolvedLink & { children: ResolvedLink[] })
  | { id: string; kind: 'group'; label: string; children: ResolvedLink[] };

export interface ResolvedNavigation {
  main: { nodes: ResolvedNode[]; bar: string[] } | null;
  actions: ResolvedLink[];
  footer: { title: string | null; nodes: ResolvedNode[] }[];
  legal: { nodes: ResolvedNode[] } | null;
}

/**
 * Why a node of a placed menu shows nothing in the locale. `label-missing` (a group or a URL link
 * without its own label) refuses publication; the others are the public consequences of rule 8,
 * which the editor shows and publication accepts.
 */
export interface NavigationProblem {
  menuId: string;
  nodeId: string;
  code: 'label-missing' | 'target-unavailable' | 'children-unreachable' | 'anchor-missing';
  /** For `children-unreachable`: the ids of the children that went with the branch. */
  children?: string[];
}

export const BLOCKING_PROBLEMS: ReadonlySet<NavigationProblem['code']> = new Set(['label-missing']);

type AnyNode = NavigationNode | NonNullable<NavigationNode['children']>[number];

export function resolveNavigation(
  doc: NavigationDocument,
  locale: string,
  targets: ReadonlyMap<string, PublishedTarget>
): { navigation: ResolvedNavigation; problems: NavigationProblem[] } {
  const problems: NavigationProblem[] = [];
  const cache = new Map<string, ResolvedNode[]>();

  const link = (menuId: string, node: AnyNode): ResolvedLink | null => {
    if (node.kind !== 'link') return null;
    const own = node.label?.[locale] ?? null;
    const t = node.target;
    if (t.kind === 'url') {
      if (!own) {
        problems.push({ menuId, nodeId: node.id, code: 'label-missing' });
        return null;
      }
      return { id: node.id, kind: 'link', label: own, target: { kind: 'url', href: t.href } };
    }
    if (t.kind === 'system')
      return { id: node.id, kind: 'link', label: own, target: { kind: 'system', page: t.page } };
    const found = targets.get(t.itemId);
    if (!found || found.access !== 'public') {
      problems.push({ menuId, nodeId: node.id, code: 'target-unavailable' });
      return null;
    }
    const label = own ?? found.featuredTitle ?? found.title;
    if (!label) {
      problems.push({ menuId, nodeId: node.id, code: 'label-missing' });
      return null;
    }
    const anchored = t.anchor !== undefined && found.blockIds.includes(t.anchor);
    // A vanished anchor still leads to the page, which is what the visitor asked for.
    if (t.anchor !== undefined && !anchored)
      problems.push({ menuId, nodeId: node.id, code: 'anchor-missing' });
    return {
      id: node.id,
      kind: 'link',
      label,
      target: {
        kind: 'content',
        itemId: found.itemId,
        type: found.type,
        slug: found.slug,
        locale,
        ...(anchored ? { anchor: t.anchor! } : {}),
      },
    };
  };

  const resolveMenu = (menu: Menu): ResolvedNode[] => {
    const nodes: ResolvedNode[] = [];
    for (const node of menu.nodes) {
      const children = (node.children ?? []).flatMap((c) => link(menu.id, c) ?? []);
      if (node.kind === 'group') {
        const label = node.label[locale];
        if (!label) {
          problems.push({ menuId: menu.id, nodeId: node.id, code: 'label-missing' });
          continue;
        }
        if (children.length) nodes.push({ id: node.id, kind: 'group', label, children });
        continue;
      }
      const own = link(menu.id, node);
      if (own) {
        nodes.push({ ...own, children });
        continue;
      }
      const label = node.label?.[locale];
      if (label && children.length) {
        nodes.push({ id: node.id, kind: 'group', label, children });
        continue;
      }
      if (children.length)
        problems.push({
          menuId: menu.id,
          nodeId: node.id,
          code: 'children-unreachable',
          children: children.map((c) => c.id),
        });
    }
    return nodes;
  };

  const menuNodesOf = (menuId: string): ResolvedNode[] => {
    const menu = doc.menus.find((m) => m.id === menuId);
    if (!menu) return [];
    if (!cache.has(menuId)) cache.set(menuId, resolveMenu(menu));
    return cache.get(menuId)!;
  };

  const { main, actions, footer, legal } = doc.placements;
  const mainNodes = main ? menuNodesOf(main.menuId) : [];
  const visible = new Set(mainNodes.map((n) => n.id));
  const navigation: ResolvedNavigation = {
    main: main ? { nodes: mainNodes, bar: main.bar.filter((id) => visible.has(id)) } : null,
    actions: actions
      ? menuNodesOf(actions.menuId).flatMap((n) => (n.kind === 'link' ? [linkOnly(n)] : []))
      : [],
    footer: footer
      .map((f) => ({ title: f.title?.[locale] ?? null, nodes: menuNodesOf(f.menuId) }))
      .filter((f) => f.nodes.length),
    legal: legal ? { nodes: menuNodesOf(legal.menuId) } : null,
  };
  return { navigation, problems: dedupe(problems) };
}

const linkOnly = ({ id, kind, label, target }: ResolvedLink): ResolvedLink => ({
  id,
  kind,
  label,
  target,
});

/** A menu in two placements is resolved once, but its problems are named once too. */
function dedupe(problems: NavigationProblem[]): NavigationProblem[] {
  const seen = new Set<string>();
  return problems.filter((p) => {
    const key = `${p.menuId} ${p.nodeId} ${p.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The content item ids the placed menus of a document target. */
export function placedTargetIds(doc: NavigationDocument): string[] {
  const placed = new Set(placedMenuIds(doc.placements));
  const ids = new Set<string>();
  for (const menu of doc.menus) {
    if (!placed.has(menu.id)) continue;
    for (const node of menuNodes(menu))
      if (node.kind === 'link' && node.target.kind === 'content') ids.add(node.target.itemId);
  }
  return [...ids];
}
