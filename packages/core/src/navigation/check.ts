// What each node of a navigation document would show in one locale, and where its text comes
// from (ADR 036 rules 5 and 8), for the menu editor: every menu, placed or not, because an editor
// builds a menu before placing it. `resolveNavigation` answers what the site renders and drops
// what shows nothing; this names each node and says why it would be dropped.
//
// Pure, like the resolver: the caller reads the published targets and the existing items in one
// batch each. Rejected: the label chain in the web front (a second copy of rule 5 that drifts from
// the resolver), and extending `resolveNavigation` with unplaced menus (its `problems` decide
// whether a locale may be published, and an unplaced menu must not block that).

import { menuNodes } from './model.js';
import type { NavigationDocument } from './model.js';
import type { PublishedTarget } from './ports.js';

export interface NodeCheck {
  menuId: string;
  nodeId: string;
  /** What visitors read in the locale; null when the node has no text there. */
  label: string | null;
  /** Its own text, the target's published featured title or title, or the front's name of a system page. */
  source: 'own' | 'featured' | 'title' | 'system' | null;
  /**
   * For a content target: `ok` when it is published publicly in the locale, `unpublished` when it
   * exists but is not, `restricted` when it is published for members only, `missing` when the item
   * is gone. Null for a group, a URL and a system page.
   */
  target: 'ok' | 'unpublished' | 'restricted' | 'missing' | null;
}

export function checkNavigation(
  doc: NavigationDocument,
  locale: string,
  targets: ReadonlyMap<string, PublishedTarget>,
  existing: ReadonlySet<string>
): NodeCheck[] {
  const out: NodeCheck[] = [];
  for (const menu of doc.menus)
    for (const node of menuNodes(menu)) {
      const own = node.label?.[locale] ?? null;
      const at = { menuId: menu.id, nodeId: node.id };
      if (node.kind === 'group' || node.target.kind === 'url') {
        out.push({ ...at, label: own, source: own ? 'own' : null, target: null });
        continue;
      }
      if (node.target.kind === 'system') {
        out.push({ ...at, label: own, source: own ? 'own' : 'system', target: null });
        continue;
      }
      const found = targets.get(node.target.itemId);
      const target = !found
        ? existing.has(node.target.itemId)
          ? 'unpublished'
          : 'missing'
        : found.access === 'public'
          ? 'ok'
          : 'restricted';
      const inherited = found?.featuredTitle
        ? ({ label: found.featuredTitle, source: 'featured' } as const)
        : found?.title
          ? ({ label: found.title, source: 'title' } as const)
          : ({ label: null, source: null } as const);
      out.push({ ...at, ...(own ? { label: own, source: 'own' as const } : inherited), target });
    }
  return out;
}

/** Every content item a document targets, in any menu. */
export function targetIds(doc: NavigationDocument): string[] {
  const ids = new Set<string>();
  for (const menu of doc.menus)
    for (const node of menuNodes(menu))
      if (node.kind === 'link' && node.target.kind === 'content') ids.add(node.target.itemId);
  return [...ids];
}
