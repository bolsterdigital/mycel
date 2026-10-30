import { describe, expect, it } from 'vitest';
import { ContentDocument, ContentDocumentInput } from '@mycel/core';
import {
  documentFrom,
  keepOrder,
  valuesOf,
  withAssigned,
  withoutLocales,
  type FormValues,
} from './content-admin.js';

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
  seo: {
    title: { nl: 'Zoektitel' },
    noindex: true,
    canonical: 'https://example.org/x',
    imageId: '01900000-0000-7000-8000-0000000000e2',
  },
  featuredImageId: '01900000-0000-7000-8000-0000000000e1',
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

  it('takes both images from their pickers: an id, none, or kept when the form has no picker', () => {
    const photo = '01900000-0000-7000-8000-0000000000e3';
    const chosen = documentFrom(
      page,
      { ...valuesOf(page), featuredImageId: photo, shareImageId: '' },
      '2026-10-23'
    );
    expect(chosen.featuredImageId).toBe(photo);
    expect(chosen.seo.imageId).toBeUndefined();
    const cleared = documentFrom(
      article,
      { ...valuesOf(article), featuredImageId: '', shareImageId: '' },
      '2026-10-23'
    );
    expect('featuredImageId' in cleared).toBe(false);
    expect(cleared.seo.imageId).toBeUndefined();
    const { featuredImageId: _f, shareImageId: _s, ...withoutPickers } = valuesOf(article);
    const kept = documentFrom(article, withoutPickers, '2026-10-23');
    expect(kept.featuredImageId).toBe(article.featuredImageId);
    expect(kept.seo.imageId).toBe(article.seo.imageId);
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

// A title-only save once posted the authors in directory order and lost the ones beyond the
// directory's first page, the section too.
describe('authors and section on a save', () => {
  const [a, b, c, d] = [1, 2, 3, 4].map((n) => `01900000-0000-7000-8000-00000000000${n}`) as [
    string,
    string,
    string,
    string,
  ];
  const doc = ContentDocument.parse({ ...article, authorIds: [b, a, c], sectionId: d });

  it('keeps the order of the document when the form posts another', () => {
    const v = { ...valuesOf(doc), authorIds: [a, b, c] };
    const out = documentFrom(doc, v, '2026-10-23');
    expect(out.type === 'article' && [out.authorIds, out.sectionId]).toEqual([[b, a, c], d]);
  });

  it('drops an unticked author and adds a new one after the others', () => {
    expect(keepOrder([b, a, c], [d, a, c])).toEqual([a, c, d]);
    expect(keepOrder([b, a], [a, a])).toEqual([a]);
  });

  it("lists the document's own entries first, also those beyond the page", async () => {
    const page = [d, a].map((id) => ({ id, name: `page ${id.at(-1)}` }));
    const found = { [b]: { id: b, name: 'looked up' } } as Record<
      string,
      { id: string; name: string }
    >;
    const list = await withAssigned(
      [b, a, c],
      page,
      async (id) => found[id] ?? null,
      (id) => ({ id, name: id })
    );
    expect(list.map((x) => x.name)).toEqual(['looked up', 'page 1', c, 'page 4']);
  });
});

describe('withoutLocales', () => {
  it('never changes the document it was given', () => {
    const before = structuredClone(article);
    withoutLocales(article, ['nl']);
    expect(article).toEqual(before);
  });
});
