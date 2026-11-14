// The site navigation fixtures (ADR 036): one document per fixture, built around item ids
// the suite created, so the core suites over memory and the database suites over Postgres read
// the same menus. `nav-migration` and `nav-space` belong to B2 and D.

import type { NavigationDocument } from '../navigation/model.js';

export interface NavBasicItems {
  about: string;
  news: string;
  campaign: string;
  privacy: string;
}

/**
 * `nav-basic`: a main menu with a content, a URL and a system link and a group of two, an actions
 * menu with two calls to action, two footer columns and a legal menu, labelled in nl and en.
 */
export function navBasic(ids: NavBasicItems): NavigationDocument {
  return {
    menus: [
      {
        id: 'main',
        name: 'Hoofdmenu',
        nodes: [
          { id: 'about', kind: 'link', target: { kind: 'content', itemId: ids.about } },
          {
            id: 'donate',
            kind: 'link',
            label: { nl: 'Doneren', en: 'Donate' },
            target: { kind: 'url', href: '/doneren' },
          },
          { id: 'search', kind: 'link', target: { kind: 'system', page: 'search' } },
          {
            id: 'themes',
            kind: 'group',
            label: { nl: 'Thema’s', en: 'Themes' },
            children: [
              { id: 'news', kind: 'link', target: { kind: 'content', itemId: ids.news } },
              {
                id: 'partner',
                kind: 'link',
                label: { nl: 'Partner', en: 'Partner' },
                target: { kind: 'url', href: 'https://example.org/partner' },
              },
            ],
          },
        ],
      },
      {
        id: 'cta',
        name: 'Acties',
        nodes: [
          {
            id: 'cta-donate',
            kind: 'link',
            label: { nl: 'Geef nu', en: 'Give now' },
            target: { kind: 'url', href: '/doneren' },
          },
          { id: 'cta-sign', kind: 'link', target: { kind: 'content', itemId: ids.campaign } },
        ],
      },
      {
        id: 'footer-about',
        name: 'Voet: over',
        nodes: [{ id: 'f-about', kind: 'link', target: { kind: 'content', itemId: ids.about } }],
      },
      {
        id: 'footer-contact',
        name: 'Voet: contact',
        nodes: [
          {
            id: 'f-mail',
            kind: 'link',
            label: { nl: 'Contact', en: 'Contact' },
            target: { kind: 'url', href: '/contact' },
          },
        ],
      },
      {
        id: 'legal',
        name: 'Juridisch',
        nodes: [{ id: 'privacy', kind: 'link', target: { kind: 'content', itemId: ids.privacy } }],
      },
    ],
    placements: {
      main: { menuId: 'main', bar: ['about', 'donate', 'themes'] },
      actions: { menuId: 'cta' },
      footer: [
        { menuId: 'footer-about', title: { nl: 'Over', en: 'About' } },
        { menuId: 'footer-contact' },
      ],
      legal: { menuId: 'legal' },
    },
  };
}

/**
 * `nav-labels`: one node per label source. `own` has its own text, `featured` inherits a featured
 * title, `title` inherits the title; the suite gives the title target a draft with another text
 * and leaves `en` out of one target.
 */
export function navLabels(ids: {
  own: string;
  featured: string;
  title: string;
}): NavigationDocument {
  return {
    menus: [
      {
        id: 'main',
        name: 'Hoofdmenu',
        nodes: [
          {
            id: 'own',
            kind: 'link',
            label: { nl: 'Eigen tekst' },
            target: { kind: 'content', itemId: ids.own },
          },
          { id: 'featured', kind: 'link', target: { kind: 'content', itemId: ids.featured } },
          { id: 'title', kind: 'link', target: { kind: 'content', itemId: ids.title } },
        ],
      },
    ],
    placements: { main: { menuId: 'main', bar: [] }, actions: null, footer: [], legal: null },
  };
}

/**
 * `nav-offline`: a linked parent with children whose page goes offline, labelled in nl and not in
 * en; a group whose only child goes; a link with a vanished anchor; and links to an item in the
 * trash, to another tenant's item and to a restricted item.
 */
export function navOffline(ids: {
  parent: string;
  child: string;
  lonely: string;
  anchored: string;
  trashed: string;
  foreign: string;
  restricted: string;
}): NavigationDocument {
  return {
    menus: [
      {
        id: 'main',
        name: 'Hoofdmenu',
        nodes: [
          {
            id: 'parent',
            kind: 'link',
            label: { nl: 'Campagnes' },
            target: { kind: 'content', itemId: ids.parent },
            children: [
              { id: 'child', kind: 'link', target: { kind: 'content', itemId: ids.child } },
              {
                id: 'child-url',
                kind: 'link',
                label: { nl: 'Archief', en: 'Archive' },
                target: { kind: 'url', href: '/archief' },
              },
            ],
          },
          {
            id: 'empty-group',
            kind: 'group',
            label: { nl: 'Leeg', en: 'Empty' },
            children: [
              { id: 'lonely', kind: 'link', target: { kind: 'content', itemId: ids.lonely } },
            ],
          },
          {
            id: 'anchored',
            kind: 'link',
            target: { kind: 'content', itemId: ids.anchored, anchor: 'gone' },
          },
          { id: 'trashed', kind: 'link', target: { kind: 'content', itemId: ids.trashed } },
          { id: 'foreign', kind: 'link', target: { kind: 'content', itemId: ids.foreign } },
          { id: 'restricted', kind: 'link', target: { kind: 'content', itemId: ids.restricted } },
        ],
      },
    ],
    placements: { main: { menuId: 'main', bar: [] }, actions: null, footer: [], legal: null },
  };
}

/** `nav-concurrency`: two menus, so saves on one base can touch different or the same menu. */
export function navConcurrency(): NavigationDocument {
  const link = (id: string, nl: string) => ({
    id,
    kind: 'link' as const,
    label: { nl },
    target: { kind: 'url' as const, href: `/${id}` },
  });
  return {
    menus: [
      { id: 'main', name: 'Hoofdmenu', nodes: [link('a', 'A'), link('b', 'B'), link('c', 'C')] },
      { id: 'footer', name: 'Voet', nodes: [link('f1', 'F1'), link('f2', 'F2')] },
    ],
    placements: {
      main: { menuId: 'main', bar: ['a'] },
      actions: null,
      footer: [{ menuId: 'footer' }],
      legal: null,
    },
  };
}

/**
 * `nav-budget`: `menus` menus of which the first holds `nodes` nodes, as top-level links; the
 * suite adds a third level, a repeated id and the over-budget variants to it.
 */
export function navBudget(menus: number, nodes: number): NavigationDocument {
  return {
    menus: Array.from({ length: menus }, (_, m) => ({
      id: `m${m}`,
      name: `Menu ${m}`,
      nodes: Array.from({ length: m === 0 ? nodes : 1 }, (_, n) => ({
        id: `m${m}n${n}`,
        kind: 'link' as const,
        label: { nl: `Link ${n}` },
        target: { kind: 'url' as const, href: `/p${n}` },
      })),
    })),
    placements: { main: null, actions: null, footer: [], legal: null },
  };
}
