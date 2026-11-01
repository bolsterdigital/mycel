// Property test for the inheritance chain (#86, brief § Table stakes 1): over random documents
// with every combination of set and empty fields, a set field always wins, an empty one falls
// back exactly one link, and `source` names the link the value came from. The expected values
// are written from the chain table in effective.ts, not from the implementation.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { exampleId } from '../../util/ids.js';
import {
  SUMMARY_MAX,
  effectiveFeaturedTitle,
  effectiveImages,
  effectiveOf,
  effectiveSeoDescription,
  effectiveSummary,
} from './effective.js';
import { ContentDocument } from '../model.js';

const L = 'nl';
const id = (n: number) => exampleId(0x8600 + n);
const maybe = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: undefined });
const word = fc.stringMatching(/^[a-z]{1,12}$/);
const text = fc.array(word, { minLength: 1, maxLength: 80 }).map((w) => w.join(' '));

const paragraph = (s: string) => ({ type: 'paragraph', content: [{ type: 'text', text: s }] });
const richText = (s: string) => ({
  id: 'body',
  type: 'rich-text',
  version: 1,
  props: { content: { [L]: { type: 'doc', content: [paragraph(s)] } } },
});

/** A page or article with every chain field independently present or absent. */
const documents = fc
  .record({
    type: fc.constantFrom('page' as const, 'article' as const),
    hero: maybe(fc.constant(id(1))),
    featuredImage: maybe(fc.constant(id(2))),
    seoImage: maybe(fc.constant(id(3))),
    title: word,
    featuredTitle: maybe(word),
    featuredDescription: maybe(word),
    seoDescription: maybe(word),
    lead: maybe(text),
    body: maybe(text),
  })
  .map((f) => ({
    fields: f,
    doc: ContentDocument.parse({
      type: f.type,
      defaultLocale: L,
      locales: [L],
      title: { [L]: f.title },
      blocks: f.body ? [richText(f.body)] : [],
      ...(f.hero ? { heroImageId: f.hero } : {}),
      ...(f.featuredImage ? { featuredImageId: f.featuredImage } : {}),
      featured: {
        ...(f.featuredTitle ? { title: { [L]: f.featuredTitle } } : {}),
        ...(f.featuredDescription ? { description: { [L]: f.featuredDescription } } : {}),
      },
      seo: {
        ...(f.seoImage ? { imageId: f.seoImage } : {}),
        ...(f.seoDescription ? { description: { [L]: f.seoDescription } } : {}),
      },
      ...(f.lead ? { lead: { [L]: f.lead } } : {}),
    }),
  }));

const site = maybe(fc.constant(id(9)));

describe('effective images', () => {
  it('take the first link of the chain that is set, and name it', () => {
    fc.assert(
      fc.property(documents, site, ({ fields: f, doc }, defaultImageId) => {
        const { hero, featured, share } = effectiveImages(doc, { defaultImageId });
        expect(hero).toEqual(
          f.hero ? { mediaId: f.hero, source: 'own' } : { mediaId: null, source: null }
        );
        const featuredChain = [
          [f.featuredImage, 'own'],
          [f.hero, 'hero'],
          [defaultImageId, 'site'],
        ] as const;
        const want = (chain: readonly (readonly [string | undefined, string])[]) => {
          const hit = chain.find(([v]) => v);
          return hit ? { mediaId: hit[0], source: hit[1] } : { mediaId: null, source: null };
        };
        expect(featured).toEqual(want(featuredChain));
        expect(share).toEqual(
          want([[f.seoImage, 'own'], [f.featuredImage, 'featured'], ...featuredChain.slice(1)])
        );
      })
    );
  });

  it('never invent an image: without any id and site default, everything is null', () => {
    const doc = ContentDocument.parse({
      type: 'page',
      defaultLocale: L,
      locales: [L],
      title: { [L]: 'x' },
      blocks: [],
    });
    expect(effectiveImages(doc).share).toEqual({ mediaId: null, source: null });
  });
});

describe('effective texts', () => {
  it('fall back one step at a time, own value as written', () => {
    fc.assert(
      fc.property(documents, ({ fields: f, doc }) => {
        expect(effectiveFeaturedTitle(doc, L)).toEqual(
          f.featuredTitle
            ? { text: f.featuredTitle, source: 'featured' }
            : { text: f.title, source: 'title' }
        );
        const summary = effectiveSummary(doc, L);
        const expected = f.featuredDescription
          ? 'featured'
          : f.lead
            ? 'lead'
            : f.body
              ? 'first-paragraph'
              : null;
        expect(summary.source).toBe(expected);
        if (expected === 'featured') expect(summary.text).toBe(f.featuredDescription);
        if (expected === null) expect(summary.text).toBeNull();

        const seo = effectiveSeoDescription(doc, L);
        if (f.seoDescription) expect(seo).toEqual({ text: f.seoDescription, source: 'seo' });
        else expect(seo).toEqual(summary);
      })
    );
  });

  it('cut a derived text at a word, within the limit', () => {
    fc.assert(
      fc.property(documents, ({ fields: f, doc }) => {
        const summary = effectiveSummary(doc, L);
        if (summary.source !== 'lead' && summary.source !== 'first-paragraph') return;
        const source = (summary.source === 'lead' ? f.lead : f.body)!;
        expect(summary.text!.length).toBeLessThanOrEqual(SUMMARY_MAX);
        if (source.length <= SUMMARY_MAX) expect(summary.text).toBe(source);
        else {
          expect(summary.text!.endsWith('…')).toBe(true);
          expect(source.startsWith(summary.text!.slice(0, -1))).toBe(true);
          expect(source[summary.text!.length - 1]).toBe(' ');
        }
      })
    );
  });

  it('take only the first paragraph of the lead and skip an empty first paragraph', () => {
    const doc = ContentDocument.parse({
      type: 'page',
      defaultLocale: L,
      locales: [L, 'en'],
      title: { [L]: 'x', en: 'x' },
      blocks: [
        {
          id: 'body',
          type: 'rich-text',
          version: 1,
          props: {
            content: {
              [L]: {
                type: 'doc',
                content: [
                  { type: 'paragraph' },
                  {
                    type: 'heading',
                    attrs: { level: 1 },
                    content: [{ type: 'text', text: 'Kop' }],
                  },
                  {
                    type: 'paragraph',
                    content: [
                      { type: 'text', text: 'Eerste' },
                      { type: 'hard_break' },
                      { type: 'text', text: 'regel' },
                    ],
                  },
                ],
              },
              en: { type: 'doc', content: [paragraph('First')] },
            },
          },
        },
      ],
      lead: { en: 'One.\n\nTwo.' },
    });
    expect(effectiveSummary(doc, L)).toEqual({ text: 'Eerste regel', source: 'first-paragraph' });
    expect(effectiveSummary(doc, 'en')).toEqual({ text: 'One.', source: 'lead' });
  });

  it('read one locale and never another', () => {
    const doc = ContentDocument.parse({
      type: 'article',
      defaultLocale: L,
      locales: [L, 'en'],
      title: { [L]: 'Titel', en: 'Title' },
      blocks: [],
      featured: { title: { en: 'Featured' } },
      lead: { [L]: 'Inleiding' },
    });
    const nl = effectiveOf(doc, L);
    expect(nl.title).toEqual({ text: 'Titel', source: 'title' });
    expect(nl.summary).toEqual({ text: 'Inleiding', source: 'lead' });
    const en = effectiveOf(doc, 'en');
    expect(en.title).toEqual({ text: 'Featured', source: 'featured' });
    expect(en.summary).toEqual({ text: null, source: null });
  });
});
