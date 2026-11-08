import { expect, it } from 'vitest';
import { localeMetadataProblems, type LocaleMetadata } from './metadata';

// The comparison is the gate, so it must fire on what a presence check lets through.
it('finds locale metadata copied from another locale', () => {
  const nl: LocaleMetadata = {
    locale: 'nl',
    title: 'Schone lucht',
    documentTitle: 'Schone lucht',
    description: 'Over ons werk',
    ogTitle: 'Schone lucht',
    ogDescription: 'Over ons werk',
    ogUrl: 'https://example.test/a',
    ogLocale: 'nl_NL',
    ogLocaleAlternates: ['en_US'],
    ogImage: null,
    ogImageAlt: null,
    canonical: 'https://example.test/a',
    hreflang: ['nl', 'en', 'x-default'],
    alts: ['Demonstranten', ''],
  };
  const en: LocaleMetadata = {
    ...nl,
    locale: 'en',
    title: 'Clean air',
    documentTitle: 'Clean air',
    ogTitle: 'Clean air',
    ogUrl: 'https://example.test/en/a',
    ogLocale: 'en_US',
    ogLocaleAlternates: ['nl_NL'],
    canonical: 'https://example.test/en/a',
  };
  expect(
    localeMetadataProblems([
      nl,
      { ...en, description: 'About', ogDescription: 'About', alts: ['Protesters', ''] },
    ])
  ).toEqual([]);
  expect(localeMetadataProblems([nl, en])).toEqual([
    'nl/en: same description',
    'nl/en: image 1 same alt',
  ]);
  expect(
    localeMetadataProblems([
      nl,
      { ...en, description: 'About', ogDescription: 'About', alts: ['Protesters', null] },
    ])
  ).toEqual(['en: image 2 has no alt']);
  const fine = { ...en, description: 'About', ogDescription: 'About', alts: ['Protesters', ''] };
  const shared = { ogImage: 'https://example.test/m.webp', describedShare: true };
  expect(localeMetadataProblems([{ ...nl, documentTitle: 'Ander' }, fine])).toEqual([
    'nl: <title> is not the title',
  ]);
  expect(localeMetadataProblems([{ ...nl, ogLocale: 'en_US' }, fine])).toEqual([
    'nl: og:locale is not this locale',
    'nl: og:locale:alternate names this locale',
    'en: no og:locale:alternate en_US',
  ]);
  expect(
    localeMetadataProblems([
      { ...nl, ...shared, ogImageAlt: 'Plein' },
      { ...fine, ...shared, ogImageAlt: 'Plein' },
    ])
  ).toEqual(['nl/en: same og:image:alt']);
  expect(
    localeMetadataProblems([
      { ...nl, ...shared, ogImageAlt: 'Plein' },
      { ...fine, ...shared },
    ])
  ).toEqual(['en: no og:image:alt', 'nl/en: og:image:alt in one locale only']);
});
