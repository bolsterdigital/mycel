// Menus for a public-site test, the way a site gets them since migration 0057: one navigation
// revision with a main menu, calls to action, a legal menu and footer columns, published in each
// given locale (ADR 036). Replaces the old chrome fields the tests used to write.
// Rejected: going through the menu editor here; the editor has its own tests.
import { useCases, type Invoker, type Principal } from '@mycel/core';

type Label = Record<string, string>;
/** A URL with its own label, or a page by id that may inherit its published title. */
type Leaf = { href: string; label: Label } | { itemId: string; label?: Label };
/** A top-level node: a link with optional sublinks, or a group (ADR 036 rule 2). */
type Link = (Leaf & { children?: Leaf[] }) | { group: Label; children: Leaf[] };
interface Links {
  main?: Link[];
  actions?: Link[];
  legal?: Link[];
  footer?: Link[];
  /** The footer column's title. */
  footerTitle?: Label;
  /** Places the main menu as a second footer column, under this title. */
  mainInFooter?: Label;
}

const target = (l: Leaf) =>
  'href' in l
    ? { kind: 'url' as const, href: l.href }
    : { kind: 'content' as const, itemId: l.itemId };
const leaf = (l: Leaf, id: string) => ({
  id,
  kind: 'link' as const,
  target: target(l),
  ...(l.label ? { label: l.label } : {}),
});

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
            nodes: links[key].map((l, i) => {
              const id = `${key}-${i + 1}`;
              const children = l.children?.map((c, j) => leaf(c, `${id}-${j + 1}`));
              return 'group' in l
                ? { id, kind: 'group' as const, label: l.group, children: children! }
                : { ...leaf(l, id), ...(children?.length ? { children } : {}) };
            }),
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
        footer: [
          ...(has('footer')
            ? [{ menuId: 'footer', ...(links.footerTitle ? { title: links.footerTitle } : {}) }]
            : []),
          ...(has('main') && links.mainInFooter
            ? [{ menuId: 'main', title: links.mainInFooter }]
            : []),
        ],
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

/** The chrome fixture's menus in three locales: what the old chrome fields held, a link with a
 * sublink, a group, two calls to action, and the main menu again as a second footer column. */
export const CHROME_FIXTURE_MENUS: Links = {
  main: [
    {
      href: '/home',
      label: { nl: 'Welkom', en: 'Home', de: 'Startseite' },
      children: [{ href: '/acties', label: { nl: 'Acties', en: 'Actions', de: 'Aktionen' } }],
    },
    { href: '/en/home', label: { nl: 'English', en: 'English', de: 'Englisch' } },
    {
      group: { nl: 'Over ons', en: 'About us', de: 'Über uns' },
      children: [
        { href: 'https://example.org/team', label: { nl: 'Team', en: 'Team', de: 'Team' } },
        {
          href: 'https://example.org/geschiedenis',
          label: { nl: 'Geschiedenis', en: 'History', de: 'Geschichte' },
        },
      ],
    },
  ],
  actions: [
    {
      href: 'https://example.org/doneer',
      label: { nl: 'Doneer nu', en: 'Donate now', de: 'Jetzt spenden' },
    },
    {
      href: 'https://example.org/doe-mee',
      label: { nl: 'Doe mee', en: 'Join us', de: 'Mitmachen' },
    },
  ],
  footerTitle: { nl: 'Contact', en: 'Contact', de: 'Kontakt' },
  mainInFooter: { nl: 'De site', en: 'This site', de: 'Die Website' },
  legal: [
    {
      href: 'https://example.org/privacy',
      label: { nl: 'Privacyverklaring', en: 'Privacy policy', de: 'Datenschutz' },
    },
  ],
  footer: [
    {
      href: 'https://example.org/support',
      label: { nl: 'Hulp', en: 'Support', de: 'Unterstützung' },
    },
    {
      href: 'https://example.org/help',
      label: { nl: 'Vraag', en: 'Help', de: 'Hilfe' },
    },
  ],
};
