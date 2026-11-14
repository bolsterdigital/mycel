// The editor's preview of a navigation revision in one locale (ADR 036 rule 7): what
// `site.navigation.check` resolves for the placed menus, laid out per placement with the menu
// each one shows and the path each link would have on the site. Core resolves (labels, what is
// left out); this only names and arranges, so the preview is the same resolution the site will
// use, not a second copy of rule 5.
//
// The resolution has no menu ids and drops a footer column that shows nothing; node ids are
// unique across the document, so a column is matched back to its placement by its nodes, and an
// empty one is shown as empty instead of vanishing from the preview.
// Rejected: rendering the preview with the public header and footer (they are a later step and
// would make this screen wait for them), and links in the preview (their paths are the site's,
// not the admin's; following one would leave the editor).

import { contentPath, type NavigationDocument, type useCases } from '@mycel/core';
import { searchPath } from '#lib/public/search-path.js';

type Check = Awaited<ReturnType<(typeof useCases.checkNavigation)['handler']>>;
type Resolved = Check['preview'];
type Node = NonNullable<Resolved['main']>['nodes'][number];
type Link = Resolved['actions'][number];

export interface PreviewItem {
  id: string;
  /** What visitors read; null for a home or search link that the site names itself. */
  label: string | null;
  system: 'home' | 'search' | null;
  /** The path on the site; null for a group. */
  href: string | null;
  inBar: boolean;
  children: PreviewItem[];
}

export interface PreviewPlacement {
  menuId: string;
  title: string | null;
  items: PreviewItem[];
}

export interface Preview {
  main: PreviewPlacement | null;
  actions: PreviewPlacement | null;
  footer: PreviewPlacement[];
  legal: PreviewPlacement | null;
}

function hrefOf(target: Link['target'], locale: string, defaultLocale: string): string {
  if (target.kind === 'url') return target.href;
  if (target.kind === 'system')
    return target.page === 'search'
      ? searchPath(locale, defaultLocale)
      : locale === defaultLocale
        ? '/'
        : `/${locale}`;
  const path = contentPath(target, target.locale, defaultLocale);
  return target.anchor ? `${path}#${target.anchor}` : path;
}

export function previewOf(
  doc: NavigationDocument,
  resolved: Resolved,
  locale: string,
  defaultLocale: string
): Preview {
  const mainBar = new Set(resolved.main?.bar ?? []);
  // The bar belongs to the main navigation: the same menu in a footer column has no bar.
  const none = new Set<string>();
  const link = (l: Link, bar = none): PreviewItem => ({
    id: l.id,
    label: l.label,
    system: l.target.kind === 'system' ? l.target.page : null,
    href: hrefOf(l.target, locale, defaultLocale),
    inBar: bar.has(l.id),
    children: [],
  });
  const node = (n: Node, bar = none): PreviewItem =>
    n.kind === 'group'
      ? {
          id: n.id,
          label: n.label,
          system: null,
          href: null,
          inBar: bar.has(n.id),
          children: n.children.map((c) => link(c)),
        }
      : { ...link(n, bar), children: n.children.map((c) => link(c)) };
  const ids = (menuId: string) =>
    new Set(
      doc.menus
        .find((m) => m.id === menuId)
        ?.nodes.flatMap((n) => [n.id, ...(n.children ?? []).map((c) => c.id)]) ?? []
    );

  const { main, actions, footer, legal } = doc.placements;
  let next = 0;
  return {
    main: main && {
      menuId: main.menuId,
      title: null,
      items: (resolved.main?.nodes ?? []).map((n) => node(n, mainBar)),
    },
    actions: actions && {
      menuId: actions.menuId,
      title: null,
      items: resolved.actions.map((l) => link(l)),
    },
    footer: footer.map((f) => {
      const column = resolved.footer[next];
      const mine = column?.nodes[0] && ids(f.menuId).has(column.nodes[0].id);
      if (mine) next += 1;
      return {
        menuId: f.menuId,
        title: f.title?.[locale] ?? null,
        items: mine ? column.nodes.map((n) => node(n)) : [],
      };
    }),
    legal: legal && {
      menuId: legal.menuId,
      title: null,
      items: (resolved.legal?.nodes ?? []).map((n) => node(n)),
    },
  };
}
