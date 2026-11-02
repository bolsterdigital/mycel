// The web catalogs stay complete in Dutch (ADR 007): `nl` is typed `Partial`, so a key added to
// `en` alone compiles and silently falls back to English in a Dutch admin. Rejected: typing `nl`
// as a full record, which turns a missing translation into a compile error far from its cause
// in every consumer instead of one named failure here.

import { describe, expect, it } from 'vitest';
import { en } from './en.js';
import { refusalCopy, ui } from './index.js';
import { nl } from './nl.js';

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('web UI catalogs', () => {
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
