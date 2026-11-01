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

// #86: a page with everything the Content and Featured tabs set.
const featuredPage = ContentDocument.parse({
  ...page,
  locales: ['nl', 'en'],
  title: { nl: 'Over ons', en: 'About us' },
  lead: { nl: 'Wie we zijn.' },
  heroImageId: '01900000-0000-7000-8000-0000000000e4',
  featured: { title: { en: 'Who we are' }, description: { nl: 'Kort over ons.' } },
});

describe('documentFrom(valuesOf(doc))', () => {
  it('gives the same document back, blocks included', () => {
    for (const doc of [article, page, featuredPage])
      expect(ContentDocument.parse(documentFrom(doc, valuesOf(doc), '2026-10-23'))).toEqual(doc);
  });

  it('replaces only the fields of the form and keeps the blocks', () => {
    const v: FormValues = { ...valuesOf(article), 'title.en': 'New report', 'seoTitle.nl': '' };
    const out = ContentDocumentInput.parse(documentFrom(article, v, '2026-10-23'));
    expect(out.title).toEqual({ nl: 'Verslag', en: 'New report' });
    expect(out.seo.title).toBeUndefined();
    expect(out.blocks).toEqual(article.blocks);
  });

  it('reads the hero alt where the form showed it, per locale, and drops it with the image (#99)', () => {
    const shown: FormValues = { ...valuesOf(featuredPage), heroAltShown: '1' };
    expect(shown.heroDecorative).toBe('on');
    // Ticked: decorative, whatever the field holds.
    expect(
      documentFrom(featuredPage, { ...shown, 'heroAlt.nl': 'Het team' }, '2026-11-01', 'nl').heroAlt
    ).toBeUndefined();
    // Unticked: the shown locale from the form, the other kept.
    const described = { ...featuredPage, heroAlt: { en: 'The team' } };
    const v: FormValues = { ...valuesOf(described), heroAltShown: '1', 'heroAlt.nl': 'Het team' };
    expect(v.heroDecorative).toBeUndefined();
    expect(documentFrom(described, v, '2026-11-01', 'nl').heroAlt).toEqual({
      nl: 'Het team',
      en: 'The team',
    });
    // Unticked with no text anywhere: `{}`, for core to refuse rather than a silent decorative.
    expect(
      documentFrom(featuredPage, { ...shown, heroDecorative: '' }, '2026-11-01', 'nl').heroAlt
    ).toEqual({});
    // A form without the fields keeps the alt; no image, no alt.
    expect(documentFrom(described, valuesOf(described), '2026-11-01').heroAlt).toEqual(
      described.heroAlt
    );
    expect(
      'heroAlt' in documentFrom(described, { ...v, heroImageId: '' }, '2026-11-01', 'nl')
    ).toBe(false);
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

  it('takes the lead, hero and featured texts on a page, and drops an empty featured (#86)', () => {
    const v = valuesOf(featuredPage);
    expect(v).toMatchObject({
      'lead.nl': 'Wie we zijn.',
      heroImageId: featuredPage.heroImageId,
      'featuredTitle.en': 'Who we are',
      'featuredDescription.nl': 'Kort over ons.',
    });
    const cleared = documentFrom(
      featuredPage,
      {
        ...v,
        'lead.nl': '',
        heroImageId: '',
        'featuredTitle.en': '',
        'featuredDescription.nl': ' ',
      },
      '2026-10-30'
    );
    expect('lead' in cleared || 'heroImageId' in cleared || 'featured' in cleared).toBe(false);
    const changed = documentFrom(
      featuredPage,
      { ...v, 'featuredDescription.nl': '', 'featuredDescription.en': 'In short.' },
      '2026-10-30'
    );
    expect(changed.featured).toEqual({
      title: { en: 'Who we are' },
      description: { en: 'In short.' },
    });
  });

  it('keeps the access when the form has no access fields (a site without readers)', () => {
    const v = valuesOf(article);
    for (const key of ['level', 'teaser', 'teaserBlocks']) delete v[key];
    v['title.nl'] = 'Nieuwe titel';
    const doc = documentFrom(article, v, '2026-10-30');
    expect(doc.access).toEqual(article.access);
    expect(doc.title).toEqual({ nl: 'Nieuwe titel', en: 'Report' });
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
