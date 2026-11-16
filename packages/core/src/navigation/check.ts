// What each node of a navigation document would show in one locale, and where its text comes
// from (ADR 036 rules 5 and 8), for the menu editor: every menu, placed or not, because an editor
// builds a menu before placing it. `resolveNavigation` answers what the site renders and drops
// what shows nothing; this names each node and says why it would be dropped.
//
// `publicationCheck` is the other half: what the placed menus of a revision would render in a
// locale and which problems refuse its publication, one function that both the editor's preview
// and `site.navigation.publish` call, so the preview cannot promise a publication that is then
// refused.
//
// Pure, like the resolver: the caller reads the published targets and the existing items in one
// batch each. Rejected: the label chain in the web front (a second copy of rule 5 that drifts from
// the resolver), and extending `resolveNavigation` with unplaced menus (its `problems` decide
// whether a locale may be published, and an unplaced menu must not block that).

import { menuNodes } from './model.js';
import type { NavigationDocument } from './model.js';
import type { PublishedTarget } from './ports.js';
import {
  BLOCKING_PROBLEMS,
  placedTargetIds,
  resolveNavigation,
  type NavigationProblem,
  type ResolvedNavigation,
} from './resolve.js';

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

/** Every content item a document targets, in any menu or as the placed zone. */
export function targetIds(doc: NavigationDocument): string[] {
  const ids = new Set<string>();
  if (doc.placements.prefooter) ids.add(doc.placements.prefooter.itemId);
  for (const menu of doc.menus)
    for (const node of menuNodes(menu))
      if (node.kind === 'link' && node.target.kind === 'content') ids.add(node.target.itemId);
  return [...ids];
}

/** A placed link to an item that no longer exists: a broken menu, not an offline page. */
export interface UnknownTarget {
  menuId: string;
  nodeId: string;
  itemId: string;
}

/** The resolver's problem or a placed target that is gone, and whether it refuses publication. */
export type PreviewProblem = (
  NavigationProblem | { menuId: string; nodeId: string; code: 'target-unknown' }
) & { blocking: boolean };

export interface PublicationCheck {
  navigation: ResolvedNavigation;
  /** The resolver's problems, as `site.navigation.publish` returns them. */
  problems: NavigationProblem[];
  /** Placed links to items that no longer exist; each refuses publication. */
  unknown: UnknownTarget[];
}

/**
 * What publishing `doc` in `locale` would put live and what refuses it (ADR 036 rules 7 and 8).
 * `targets` and `existing` must cover at least `placedTargetIds(doc)`.
 */
export function publicationCheck(
  doc: NavigationDocument,
  locale: string,
  targets: ReadonlyMap<string, PublishedTarget>,
  existing: ReadonlySet<string>
): PublicationCheck {
  const { navigation, problems } = resolveNavigation(doc, locale, targets);
  const placed = new Set(placedTargetIds(doc));
  const unknown: UnknownTarget[] = [];
  for (const menu of doc.menus)
    for (const node of menuNodes(menu))
      if (
        node.kind === 'link' &&
        node.target.kind === 'content' &&
        placed.has(node.target.itemId) &&
        !existing.has(node.target.itemId)
      )
        unknown.push({ menuId: menu.id, nodeId: node.id, itemId: node.target.itemId });
  return { navigation, problems, unknown };
}

/** The problems of a check as one list for the editor: a gone target replaces "unavailable". */
export function previewProblems({ problems, unknown }: PublicationCheck): PreviewProblem[] {
  const gone = new Set(unknown.map((u) => `${u.menuId} ${u.nodeId}`));
  return [
    ...problems
      .filter((p) => p.code !== 'target-unavailable' || !gone.has(`${p.menuId} ${p.nodeId}`))
      .map((p) => ({ ...p, blocking: BLOCKING_PROBLEMS.has(p.code) })),
    ...unknown.map(({ menuId, nodeId }) => ({
      menuId,
      nodeId,
      code: 'target-unknown' as const,
      blocking: true,
    })),
  ];
}
