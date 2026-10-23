import { describe, expect, it } from 'vitest';
import { ContentDocument, ContentDocumentInput } from '@mycel/core';
import { documentFrom, valuesOf, withoutLocales, type FormValues } from './content-admin.js';

const prose = (id: string, text: Record<string, string>) => ({
  id,
  type: 'rich-text',
  version: 1,
  props: {
    content: Object.fromEntries(
      Object.entries(text).map(([l, t]) => [
        l,
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] },
      ])
    ),
  },
});

const article = ContentDocument.parse({
  type: 'article',
  title: { nl: 'Verslag', en: 'Report' },
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  blocks: [prose('b1', { nl: 'Tekst', en: 'Text' })],
  seo: { title: { nl: 'Zoektitel' }, noindex: true, canonical: 'https://example.org/x' },
  access: { level: 'members', teaser: { blocks: 1 } },
  lead: { nl: 'Kern' },
  authorIds: ['01900000-0000-7000-8000-000000000001'],
  tags: ['wonen', 'huur'],
  corrections: [{ date: '2026-10-01', text: { nl: 'Gecorrigeerd', en: 'Corrected' } }],
});

const page = ContentDocument.parse({
  type: 'page',
  title: { nl: 'Over ons' },
  defaultLocale: 'nl',
  locales: ['nl'],
  blocks: [],
});

describe('documentFrom(valuesOf(doc))', () => {
  it('gives the same document back, blocks included', () => {
    for (const doc of [article, page])
      expect(ContentDocument.parse(documentFrom(doc, valuesOf(doc), '2026-10-23'))).toEqual(doc);
  });

  it('replaces only the fields of the form and keeps the blocks', () => {
    const v: FormValues = { ...valuesOf(article), 'title.en': 'New report', 'seoTitle.nl': '' };
    const out = ContentDocumentInput.parse(documentFrom(article, v, '2026-10-23'));
    expect(out.title).toEqual({ nl: 'Verslag', en: 'New report' });
    expect(out.seo.title).toBeUndefined();
    expect(out.blocks).toEqual(article.blocks);
  });

  it('adds a correction with today as its default date', () => {
    const v = { ...valuesOf(article), 'correctionText.nl': 'Naam hersteld' };
    const out = documentFrom(article, v, '2026-10-23');
    expect(out.type === 'article' && out.corrections.at(-1)).toEqual({
      date: '2026-10-23',
      text: { nl: 'Naam hersteld' },
    });
  });

  it('removes a dropped locale everywhere, blocks included', () => {
    const v = { ...valuesOf(article), locales: ['nl'] };
    const out = ContentDocumentInput.parse(documentFrom(article, v, '2026-10-23'));
    expect(out.locales).toEqual(['nl']);
    expect(Object.keys(out.title)).toEqual(['nl']);
    expect(JSON.stringify(out)).not.toContain('"en"');
  });
});

describe('withoutLocales', () => {
  it('never changes the document it was given', () => {
    const before = structuredClone(article);
    withoutLocales(article, ['nl']);
    expect(article).toEqual(before);
  });
});
