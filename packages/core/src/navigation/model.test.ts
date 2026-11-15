// `nav-budget` and the shape rules of ADR 036 rules 2 to 4: what the schema refuses and what
// `navigationIssues` refuses, so a save never stores a document a renderer cannot draw.

import { describe, expect, it } from 'vitest';
import { exampleId } from '../util/ids.js';
import { navBasic, navBudget } from '../testing/navigation-fixtures.js';
import { NavigationDocument, navigationIssues, navigationReferences } from './model.js';

const codes = (doc: unknown) =>
  navigationIssues(NavigationDocument.parse(doc)).map((i) => i.message);
const ids = {
  about: exampleId(0x1),
  news: exampleId(0x2),
  campaign: exampleId(0x3),
  privacy: exampleId(0x4),
};

describe('nav-budget', () => {
  it('accepts the limits themselves: 20 menus, 100 nodes in one menu', () => {
    expect(codes(navBudget(20, 100))).toEqual([]);
  });

  it('refuses a 21st menu and a 101st node in one menu', () => {
    expect(codes(navBudget(21, 1))).toEqual(['site.navigation.budget.menus']);
    expect(codes(navBudget(1, 101))).toEqual(['site.navigation.budget.nodes']);
  });

  it('refuses more than 500 nodes on the site', () => {
    const doc = navBudget(6, 100);
    expect(codes(doc)).toEqual([]);
    const big = NavigationDocument.parse(doc);
    big.menus.forEach((menu, m) => {
      if (m === 0) return;
      menu.nodes = navBudget(1, 100).menus[0]!.nodes.map((n) => ({ ...n, id: `x${m}${n.id}` }));
    });
    expect(navigationIssues(big).map((i) => i.message)).toEqual(['site.navigation.budget.site']);
  });

  it('refuses a third level instead of flattening it', () => {
    const doc = navBasic(ids);
    const deep = structuredClone(doc) as unknown as {
      menus: { nodes: { children?: unknown[] }[] }[];
    };
    (deep.menus[0]!.nodes[3]!.children![0] as Record<string, unknown>)['children'] = [
      { id: 'deep', kind: 'link', target: { kind: 'system', page: 'home' } },
    ];
    expect(NavigationDocument.safeParse(deep).success).toBe(false);
  });

  it('refuses a repeated node id, which is also the only way to write a cycle', () => {
    const doc = navBudget(1, 2);
    doc.menus[0]!.nodes[1]!.id = doc.menus[0]!.nodes[0]!.id;
    expect(codes(doc)).toEqual(['site.navigation.node.duplicate']);
    const cycle = navBasic(ids);
    const group = cycle.menus[0]!.nodes[3]!;
    group.children![0]!.id = group.id;
    expect(codes(cycle)).toEqual(['site.navigation.node.duplicate']);
  });

  it('refuses a repeated menu id', () => {
    const doc = navBudget(2, 1);
    doc.menus[1]!.id = 'm0';
    doc.menus[1]!.nodes[0]!.id = 'other';
    expect(codes(doc)).toEqual(['site.navigation.menu.duplicate']);
  });
});

describe('placements', () => {
  it('accept nav-basic', () => {
    expect(codes(navBasic(ids))).toEqual([]);
  });

  it('name menus and top-level nodes of the document', () => {
    const doc = navBasic(ids);
    doc.placements.main = { menuId: 'main', bar: ['news', 'about', 'about'] };
    doc.placements.legal = { menuId: 'nope' };
    expect(codes(doc)).toEqual([
      'site.navigation.placement.unknown-node',
      'site.navigation.placement.duplicate-node',
      'site.navigation.placement.unknown-menu',
    ]);
  });

  it('allow at most two calls to action, links only, and four footer columns', () => {
    const doc = navBasic(ids);
    doc.placements.actions = { menuId: 'main' };
    doc.placements.footer = Array.from({ length: 5 }, () => ({ menuId: 'legal' }));
    expect(codes(doc)).toEqual([
      'site.navigation.placement.actions',
      'site.navigation.budget.footer',
    ]);
  });

  it('accept a URL that is site-relative or https, nothing else', () => {
    for (const href of ['/a', 'https://example.org'])
      expect(NavigationDocument.safeParse(withHref(href)).success).toBe(true);
    for (const href of [
      '//evil.example',
      'javascript:alert(1)',
      'http://example.org',
      'mailto:x@y.z',
    ])
      expect(NavigationDocument.safeParse(withHref(href)).success).toBe(false);
  });
});

describe('navigationReferences', () => {
  it('lists each content target once per menu', () => {
    expect(navigationReferences(navBasic(ids))).toEqual([
      { menuId: 'main', itemId: ids.about },
      { menuId: 'main', itemId: ids.news },
      { menuId: 'cta', itemId: ids.campaign },
      { menuId: 'footer-about', itemId: ids.about },
      { menuId: 'legal', itemId: ids.privacy },
    ]);
  });
});

function withHref(href: string) {
  const doc = navBudget(1, 1);
  (doc.menus[0]!.nodes[0]! as { target: unknown }).target = { kind: 'url', href };
  return doc;
}
