// Whether a menu anchor lands on something (brief site-navigation § D3, ADR 036 rule 3). Core
// checks that the anchor names a top-level block of the published revision (`anchor-missing`);
// whether that block shows anything depends on its references as a visitor resolves them, which
// only the renderer knows (`lib/blocks/shown.ts`). So the menu editor asks: it reads the target as
// the site's anonymous reader through `content.published.get`, resolves it like the public page
// and renders the blocks. The editor learns one fact per anchor, that the part shows nothing on
// the site now, which the public page shows anyone: never which reference failed or why, so a
// form behind `forms:read` or a restricted image is not named to an editor without that access.
//
// Rejected: the check in `site.navigation.check`, which cannot render, so it would hold a second
// copy of the renderer's rules; and the published URL dropping the anchor, which lands on the same
// top of the page and would change the representation and its validator for a warning.

import {
  menuNodes,
  placedMenuIds,
  useCases,
  UseCaseError,
  type ContentType,
  type NavigationDocument,
} from '@mycel/core';
import { resolveDocument, runtimeSource } from '#lib/blocks/resolve.js';
import { shownBlockIds } from '#lib/blocks/shown.js';
import { previewBase, previewSite, siteReader } from '../content/preview.js';
import { runtime } from '../runtime.js';

type Check = Awaited<ReturnType<(typeof useCases.checkNavigation)['handler']>>;
type Link = Check['preview']['actions'][number];
type Node = Link | NonNullable<Check['preview']['main']>['nodes'][number];

/**
 * The ids of the top-level blocks of the published `route` in `locale` that render an element
 * for a visitor; null when visitors get no such page there.
 */
export async function shownAnchors(
  tenantId: string,
  route: { type: ContentType; slug: string },
  locale: string
): Promise<Set<string> | null> {
  const { invoker, uow, tenants } = runtime();
  const tenant = await tenants.findById(tenantId);
  if (!tenant) return null;
  const reader = siteReader(await previewSite(tenant));
  const item = await invoker
    .run(useCases.getPublished, reader, { ...route, locale })
    .catch((e: unknown) => {
      if (e instanceof UseCaseError && e.code === 'not_found') return null;
      throw e;
    });
  if (!item) return null;
  const source = runtimeSource({ invoker, uow, reader, defaultLocale: tenant.defaultLocale });
  const model = await resolveDocument(source, item, {
    base: previewBase(tenant.slug),
    fallbackLocale: tenant.defaultLocale,
  });
  return shownBlockIds(model);
}

/**
 * The placed links whose anchor the preview keeps but whose block shows nothing on the site now:
 * visitors land at the top of the page. One read per anchored page. A node whose anchor core
 * already dropped (`anchor-missing`) or that is not shown at all is not repeated here.
 */
export async function emptyAnchors(
  tenantId: string,
  document: NavigationDocument,
  preview: Check['preview'],
  locale: string
): Promise<{ menuId: string; nodeId: string }[]> {
  const nodes: Node[] = [
    ...(preview.main?.nodes ?? []),
    ...preview.actions,
    ...preview.footer.flatMap((f) => f.nodes),
    ...(preview.legal?.nodes ?? []),
  ];
  const links = nodes.flatMap((n): Link[] => [
    ...(n.kind === 'link' ? [n] : []),
    ...('children' in n ? n.children : []),
  ]);
  const pages = new Map<string, { type: ContentType; slug: string }>();
  const kept = new Set<string>();
  for (const { target } of links)
    if (target.kind === 'content' && target.anchor) {
      pages.set(target.itemId, { type: target.type, slug: target.slug });
      kept.add(`${target.itemId}#${target.anchor}`);
    }
  if (!kept.size) return [];
  const shown = new Map<string, Set<string> | null>();
  for (const [itemId, route] of pages)
    shown.set(itemId, await shownAnchors(tenantId, route, locale));
  const out: { menuId: string; nodeId: string }[] = [];
  for (const menuId of placedMenuIds(document.placements)) {
    const menu = document.menus.find((m) => m.id === menuId);
    for (const node of menu ? menuNodes(menu) : []) {
      const t = node.kind === 'link' ? node.target : null;
      if (t?.kind !== 'content' || !t.anchor || !kept.has(`${t.itemId}#${t.anchor}`)) continue;
      const parts = shown.get(t.itemId);
      if (parts && !parts.has(t.anchor)) out.push({ menuId, nodeId: node.id });
    }
  }
  return out;
}
