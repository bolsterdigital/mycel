// The placements form gives a document core accepts: the bar follows the menu's order and only
// changes for the menu that was placed, footer titles keep their other locales, also when their
// menu moves to another slot, and a removed menu is refused rather than placed.
import { describe, expect, it } from 'vitest';
import { NavigationDocument, navigationIssues, type NavigationDocument as Doc } from '@mycel/core';
import { changedChoices, formOf, placementsFrom, postedForm } from './placements.js';

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
      { menuId: 'other', title: { nl: 'Meer', en: 'About' } },
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

  it('takes the titles in other locales along when a menu moves to another slot', () => {
    const d = doc();
    const form = formOf(d.placements, 'nl');
    form.footer = [
      { menuId: 'main', title: '' },
      { menuId: '', title: '' },
      { menuId: 'other', title: 'Over' },
      { menuId: '', title: '' },
    ];
    expect(placementsFrom(d, form, 'nl')?.footer).toEqual([
      { menuId: 'main' },
      { menuId: 'other', title: { nl: 'Over', en: 'About' } },
    ]);
  });

  it('swaps two columns with their titles, and gives a second copy of a menu none', () => {
    const d = doc();
    d.placements.footer = [
      { menuId: 'other', title: { nl: 'Over', en: 'About' } },
      { menuId: 'main', title: { nl: 'Menu', en: 'Menu en' } },
    ];
    const form = formOf(d.placements, 'nl');
    form.footer = [
      { menuId: 'main', title: 'Menu' },
      { menuId: 'other', title: 'Over' },
      { menuId: 'other', title: '' },
      { menuId: '', title: '' },
    ];
    expect(placementsFrom(d, form, 'nl')?.footer).toEqual([
      { menuId: 'main', title: { nl: 'Menu', en: 'Menu en' } },
      { menuId: 'other', title: { nl: 'Over', en: 'About' } },
      { menuId: 'other' },
    ]);
  });

  it('places a zone above the footer, and takes it off again', () => {
    const d = doc();
    const zone = '01900000-0000-7000-8000-000000000abc';
    const placed = placementsFrom(d, { ...formOf(d.placements, 'nl'), prefooter: zone }, 'nl')!;
    expect(placed.prefooter).toEqual({ itemId: zone });
    const off = { ...d, placements: placed };
    expect(formOf(placed, 'nl').prefooter).toBe(zone);
    expect(placementsFrom(off, { ...formOf(placed, 'nl'), prefooter: '' }, 'nl')!.prefooter).toBe(
      null
    );
  });

  it('refuses a menu the document no longer has, and empties what is set to none', () => {
    const d = doc();
    expect(placementsFrom(d, { ...formOf(d.placements, 'nl'), actions: 'gone' }, 'nl')).toBeNull();
    const none = { main: '', bar: null, actions: '', footer: [], legal: '', prefooter: '' };
    expect(placementsFrom(d, none, 'nl')).toEqual({
      main: null,
      actions: null,
      footer: [],
      legal: null,
    });
  });
});

describe('changedChoices', () => {
  it('omits another editor’s changes and choices already saved by both editors', () => {
    const base = formOf(doc().placements, 'nl');
    const mine = structuredClone(base);
    const saved = structuredClone(base);
    mine.main = 'other';
    saved.main = '';
    saved.actions = 'other';
    saved.footer[0]!.title = 'Their title';
    saved.legal = 'other';
    mine.footer[1] = { menuId: 'main', title: 'Shared' };
    saved.footer[1] = { menuId: 'main', title: 'Shared' };
    expect(changedChoices(mine, saved, base)).toEqual([{ place: 'main', menuId: 'other' }]);
  });

  it('reads a posted form back as the form it showed', () => {
    const d = doc();
    const shown = formOf(d.placements, 'nl');
    expect(
      postedForm({
        main: 'main',
        barShown: '1',
        'bar:a': 'on',
        actions: '',
        footer0: 'other',
        footer0Title: 'Over',
        footer1: '',
        footer1Title: '',
        legal: '',
      })
    ).toEqual(shown);
    expect(postedForm({ main: 'other' }).bar).toBeNull();
  });

  it('names only what the refused form chose differently, in the order of the form', () => {
    const saved = formOf(doc().placements, 'nl');
    const mine = structuredClone(saved);
    expect(changedChoices(mine, saved, saved)).toEqual([]);
    mine.bar = ['a', 'b'];
    mine.footer[0]!.title = ' Meer ';
    mine.footer[2] = { menuId: 'main', title: '' };
    mine.legal = 'other';
    expect(changedChoices(mine, saved, saved)).toEqual([
      { place: 'bar', ids: ['a', 'b'] },
      { place: 'footer', slot: 1, menuId: 'other', title: 'Meer' },
      { place: 'footer', slot: 3, menuId: 'main', title: '' },
      { place: 'legal', menuId: 'other' },
    ]);
  });

  it('leaves out the bar of another main menu and says "none" as an empty choice', () => {
    const saved = formOf(doc().placements, 'nl');
    const mine = { ...structuredClone(saved), main: 'other', bar: ['x'], actions: '' };
    mine.footer[0] = { menuId: '', title: 'ignored' };
    expect(changedChoices(mine, saved, saved)).toEqual([
      { place: 'main', menuId: 'other' },
      { place: 'footer', slot: 1, menuId: '', title: '' },
    ]);
  });
});
