// The web catalogs stay complete in Dutch (ADR 007): `nl` is typed `Partial`, so a key added to
// `en` alone compiles and silently falls back to English in a Dutch admin. Rejected: typing `nl`
// as a full record, which turns a missing translation into a compile error far from its cause
// in every consumer instead of one named failure here.

import { describe, expect, it } from 'vitest';
import { en, enAreas } from './en.js';
import { plural, refusalCopy, ui } from './index.js';
import { nl, nlAreas } from './nl.js';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('web UI catalogs', () => {
  // The areas are merged by spread, which keeps the last of two equal keys without a word.
  it.each([
    ['en', enAreas, en],
    ['nl', nlAreas, nl],
  ] as const)('declare each %s key in one area only', (_, areas, merged) => {
    const declared = areas.reduce((n, area) => n + Object.keys(area).length, 0);
    expect(declared).toBe(Object.keys(merged).length);
  });

  it('translate every English key into Dutch', () => {
    expect(Object.keys(en).filter((k) => !(k in nl))).toEqual([]);
  });

  it('use the same placeholders in both languages', () => {
    const differ = Object.entries(nl).filter(
      ([key, text]) =>
        JSON.stringify(placeholders(text)) !==
        JSON.stringify(placeholders(en[key as keyof typeof en]))
    );
    expect(differ.map(([key]) => key)).toEqual([]);
  });
});

describe('counted phrases', () => {
  const keys = Object.keys(en);
  const forms = (form: string) =>
    keys.filter((k) => k.endsWith(`.${form}`)).map((k) => k.slice(0, -form.length - 1));

  it('give every one-form an other-form, the fallback for every language', () => {
    expect(forms('one').filter((base) => !keys.includes(`${base}.other`))).toEqual([]);
  });

  it('use only the CLDR forms Dutch and English have, with the count as {n}', () => {
    // `.many` is a CLDR form of its own (Polish, Russian), never "more than one".
    expect(keys.filter((k) => /\.(zero|two|few|many)$/.test(k))).toEqual([]);
    const counted = forms('one').flatMap((base) => [`${base}.one`, `${base}.other`]);
    expect(counted.filter((k) => !en[k as keyof typeof en].includes('{n}'))).toEqual([]);
  });

  it('pick the form by the language rules, not by n === 1', () => {
    expect(plural(ui('en'), 'admin.attention.count', 1)).toBe('1 notification');
    expect(plural(ui('en'), 'admin.attention.count', 0)).toBe('0 notifications');
    expect(plural(ui('nl'), 'admin.attention.count', 2)).toBe('2 meldingen');
    // French counts 0 as `one`; Polish 2 is `few`, which no catalog has, so it falls back to other.
    expect(plural(ui('fr'), 'admin.attention.count', 0)).toBe('0 notification');
    expect(plural(ui('pl'), 'admin.attention.count', 2)).toBe('2 notifications');
    expect(plural(ui('en'), 'admin.media.list.count', 1200, { n: '1,200' })).toBe('1,200 files');
  });
});

describe('refusalCopy', () => {
  const t = ui('en');

  it('names what a limit refused, so no placeholder reaches the operator', () => {
    const copy = refusalCopy(t, {
      error: 'admin.limit.reached',
      what: 'admin.limit.what.other',
    });
    expect(copy).toContain(en['admin.limit.what.other']);
    expect(copy).not.toContain('{');
  });

  // #140: the sentence for a refusal of "something" has no slot, so it reads in both languages.
  it.each(['nl', 'en'])('reads a switched-off feature without a name in %s', (locale) => {
    const text = refusalCopy(ui(locale), { error: 'admin.limit.featureOff.other' });
    expect(text).not.toMatch(/\{|geen dit|include this\./);
    expect(text).toMatch(locale === 'nl' ? /^Dit onderdeel hoort niet/ : /include this feature\./);
  });

  it('shows a plain refusal as it is, and fills what the page adds', () => {
    expect(refusalCopy(t, { error: 'admin.error.suspended' })).toBe(en['admin.error.suspended']);
    expect(
      refusalCopy(
        t,
        { error: 'admin.media.error.inUse.other', what: undefined },
        { n: 3, filename: 'a.jpg' }
      )
    ).not.toContain('{n}');
  });
});
