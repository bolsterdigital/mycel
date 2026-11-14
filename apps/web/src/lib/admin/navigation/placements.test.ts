// The placements form gives a document core accepts: the bar follows the menu's order and only
// changes for the menu that was placed, footer titles keep their other locales, and a removed
// menu is refused rather than placed.
import { describe, expect, it } from 'vitest';
import { NavigationDocument, navigationIssues, type NavigationDocument as Doc } from '@mycel/core';
import { formOf, placementsFrom } from './placements.js';

const link = (id: string) =>
  ({ id, kind: 'link', target: { kind: 'url', href: `/${id}` }, label: { nl: id } }) as const;
const doc = (): Doc => ({
  menus: [
    { id: 'main', name: 'Main', nodes: [link('a'), link('b'), link('c')] },
    { id: 'other', name: 'Other', nodes: [link('x'), link('y')] },
  ],
  placements: {
    main: { menuId: 'main', bar: ['a'] },
    actions: null,
    footer: [{ menuId: 'other', title: { nl: 'Over', en: 'About' } }],
    legal: null,
  },
});
const valid = (d: Doc) => navigationIssues(NavigationDocument.parse(d));

describe('placementsFrom', () => {
  it('shows a saved document again as the form that would keep it', () => {
    const d = doc();
    expect(placementsFrom(d, formOf(d.placements, 'nl'), 'nl')).toEqual(d.placements);
    expect(formOf(d.placements, 'nl').footer).toHaveLength(4);
  });

  it('takes the ticked bar items in the order of the menu', () => {
    const d = doc();
    const form = { ...formOf(d.placements, 'nl'), bar: ['c', 'a', 'gone'] };
    expect(placementsFrom(d, form, 'nl')?.main).toEqual({ menuId: 'main', bar: ['a', 'c'] });
  });

  it('puts all top-level items of a newly chosen main menu in the bar', () => {
    const d = doc();
    const form = { ...formOf(d.placements, 'nl'), main: 'other', bar: ['a'] };
    const placements = placementsFrom(d, form, 'nl')!;
    expect(placements.main).toEqual({ menuId: 'other', bar: ['x', 'y'] });
    expect(valid({ ...d, placements })).toEqual([]);
  });

  it('places one menu in several places, in slot order, without empty slots', () => {
    const d = doc();
    const form = formOf(d.placements, 'nl');
    form.footer = [
      { menuId: '', title: '' },
      { menuId: 'main', title: '' },
      { menuId: 'other', title: 'Meer' },
      { menuId: '', title: 'ignored' },
    ];
    form.legal = 'other';
    const placements = placementsFrom(d, form, 'nl')!;
    expect(placements.footer).toEqual([
      { menuId: 'main' },
      { menuId: 'other', title: { nl: 'Meer' } },
    ]);
    expect(placements.legal).toEqual({ menuId: 'other' });
    expect(valid({ ...d, placements })).toEqual([]);
  });

  it('keeps a column title in other locales while it shows the same menu, and clears one', () => {
    const d = doc();
    const form = formOf(d.placements, 'nl');
    form.footer[0]!.title = '';
    expect(placementsFrom(d, form, 'nl')?.footer).toEqual([
      { menuId: 'other', title: { en: 'About' } },
    ]);
    form.footer[0]!.title = 'Nieuw';
    expect(placementsFrom(d, form, 'nl')?.footer[0]?.title).toEqual({ nl: 'Nieuw', en: 'About' });
  });

  it('refuses a menu the document no longer has, and empties what is set to none', () => {
    const d = doc();
    expect(placementsFrom(d, { ...formOf(d.placements, 'nl'), actions: 'gone' }, 'nl')).toBeNull();
    const none = { main: '', bar: null, actions: '', footer: [], legal: '' };
    expect(placementsFrom(d, none, 'nl')).toEqual({
      main: null,
      actions: null,
      footer: [],
      legal: null,
    });
  });
});
