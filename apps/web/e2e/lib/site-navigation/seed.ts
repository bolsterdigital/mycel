// Menus for a public-site test, the way a site gets them since #107 B2: one navigation revision
// with a main menu, a legal menu and a footer column of URL links, published in each given
// locale (ADR 036). Replaces the old chrome fields the tests used to write.
// Rejected: going through the menu editor here; the editor has its own tests.
import { useCases, type Invoker, type Principal } from '@mycel/core';

type Label = Record<string, string>;
/** A URL with its own label, or a page by id that may inherit its published title. */
type Link = { href: string; label: Label } | { itemId: string; label?: Label };
interface Links {
  main?: Link[];
  actions?: Link[];
  legal?: Link[];
  footer?: Link[];
  /** The footer column's title. */
  footerTitle?: Label;
}

export async function publishMenus(
  invoker: Invoker,
  principal: Principal,
  links: Links,
  locales: string[]
) {
  const menu = (key: 'main' | 'actions' | 'legal' | 'footer') =>
    links[key]?.length
      ? [
          {
            id: key,
            name: key,
            nodes: links[key].map((l, i) => ({
              id: `${key}-${i + 1}`,
              kind: 'link' as const,
              target:
                'href' in l
                  ? { kind: 'url' as const, href: l.href }
                  : { kind: 'content' as const, itemId: l.itemId },
              ...(l.label ? { label: l.label } : {}),
            })),
          },
        ]
      : [];
  const menus = [...menu('main'), ...menu('actions'), ...menu('legal'), ...menu('footer')];
  const has = (key: string) => menus.some((m) => m.id === key);
  const current = await invoker.run(useCases.getNavigation, principal, {});
  const saved = await invoker.run(useCases.updateNavigation, principal, {
    baseRevisionId: current.revisionId,
    document: {
      menus,
      placements: {
        main: has('main') ? { menuId: 'main', bar: menus[0]!.nodes.map((n) => n.id) } : null,
        actions: has('actions') ? { menuId: 'actions' } : null,
        footer: has('footer')
          ? [{ menuId: 'footer', ...(links.footerTitle ? { title: links.footerTitle } : {}) }]
          : [],
        legal: has('legal') ? { menuId: 'legal' } : null,
      },
    },
  });
  for (const locale of locales)
    await invoker.run(useCases.publishNavigation, principal, {
      revisionId: saved.revisionId!,
      locale,
    });
}
