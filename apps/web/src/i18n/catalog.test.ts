// The web catalogs stay complete in Dutch (ADR 007): `nl` is typed `Partial`, so a key added to
// `en` alone compiles and silently falls back to English in a Dutch admin. Rejected: typing `nl`
// as a full record, which turns a missing translation into a compile error far from its cause
// in every consumer instead of one named failure here.

import { describe, expect, it } from 'vitest';
import { en } from './en.js';
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
