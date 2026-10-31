// The data-loss point of #66 PR 4 (tier flagship-review): the edit screen shows one locale, and a
// save of that form must never change another locale. Property: for a document in two or three
// locales with every block type, and any edit of exactly the fields the screen renders for locale
// A (typed, emptied, a caption mode switched), the document `formDocument` makes has, for every
// other locale B, the same values in the same order as the base revision, and the same locales.
// The form is built the way the screen builds it (`valuesOf` and `formValues` for [A] only) and
// read back through the commit's own path (`valuesFromForm`, `posted`), so the test exercises
// what a post does, not a model of it.
//
// fast-check with `fc.gen()`, as lifecycle.test.ts: a failure shrinks to the fields and edits
// that lose a value and prints the seed that replays it.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_DEFINITIONS,
  BLOCK_TYPES,
  ContentDocument,
  localizedFields,
  type ContentDocumentInput,
} from '@mycel/core';
import { formValues, posted } from '#lib/editor/block-form.js';
import { valuesFromForm, valuesOf, withLocale } from './content-admin.js';
import { blockPrefix, formDocument } from './edit-form.js';

const LOCALE_KEY = /^[a-z]{2}$/;

/** Every block example of the registry with an id, in nl and en. */
const examples = BLOCK_TYPES.flatMap((type) =>
  BLOCK_DEFINITIONS[type].examples.map((e) => ({ type, props: e.props }))
);

/** A document of `type` with the chosen examples, no two text blocks side by side. */
function documentOf(type: 'page' | 'article', picks: number[], third: boolean): ContentDocument {
  const blocks: { id: string; type: string; version: number; props: unknown }[] = [];
  picks.forEach((n, i) => {
    const e = examples[n % examples.length]!;
    if (e.type === 'rich-text' && blocks.at(-1)?.type === 'rich-text') return;
    if (e.type === 'paywall' && blocks.some((b) => b.type === 'paywall')) return;
    blocks.push({
      id: `b${i}`,
      type: e.type,
      version: BLOCK_DEFINITIONS[e.type].version,
      props: structuredClone(e.props),
    });
  });
  const doc = ContentDocument.parse({
    type,
    title: { nl: 'Titel', en: 'Title' },
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    blocks,
    lead: { nl: 'Kern', en: 'Gist' },
    // A paywall block stands only in a document whose teaser ends at it.
    ...(blocks.some((b) => b.type === 'paywall')
      ? { access: { level: 'members', teaser: 'marker' } }
      : {}),
    seo: { title: { nl: 'Zoek', en: 'Search' }, description: { en: 'Only English' } },
    featured: { title: { nl: 'Kort' }, description: { nl: 'Samenvatting', en: 'Summary' } },
    ...(type === 'article'
      ? {
          authorIds: [],
          tags: ['a'],
          corrections: [{ date: '2026-10-01', text: { nl: 'Fout', en: 'Error' } }],
        }
      : {}),
  });
  // A third locale with every value of en, so "other locales" is more than one.
  return third ? ContentDocument.parse(withLocale(doc, 'de', 'en')) : doc;
}

/** What the screen renders for locale `a`: the document's fields of that locale, every block's. */
function screenForm(doc: ContentDocument, a: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(valuesOf(doc))) {
    const last = k.split('.').at(-1)!;
    if (k.includes('.') && LOCALE_KEY.test(last) && last !== a) continue;
    out[k] = v;
  }
  out['correctionText.' + a] = '';
  out['editLocale'] = a;
  out['baseRevisionId'] = '01900000-0000-7000-8000-000000000001';
  for (const b of doc.blocks)
    for (const [k, v] of Object.entries(
      formValues(BLOCK_DEFINITIONS[b.type].fields, b.props as Record<string, unknown>, [a])
    ))
      out[`${blockPrefix(b.id)}${k}`] = v;
  return out;
}

const formData = (values: Record<string, string | string[]>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(values))
    for (const x of Array.isArray(v) ? v : [v]) data.append(k, x);
  return data;
};

/** Every value of locale `b`, in document order, by its path without list positions. */
function valuesIn(doc: ContentDocument | ContentDocumentInput, b: string) {
  return localizedFields(doc as ContentDocument)
    .filter((f) => f.value[b] !== undefined)
    .map((f) => [f.path.filter((p) => typeof p === 'string').join('.'), f.value[b]]);
}

/** Does the name hold a value of locale `a` (`title.a`, `b.x.p.caption.a.mode`)? */
const ofLocale = (name: string, a: string) => name.endsWith(`.${a}`) || name.endsWith(`.${a}.mode`);

describe('a save in one locale (#66 PR 4)', () => {
  it('never changes another locale, whatever is typed, emptied or switched', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('page' as const, 'article' as const),
        fc.array(fc.nat(), { minLength: 0, maxLength: 14 }),
        fc.boolean(),
        fc.gen(),
        (type, picks, third, g) => {
          const base = documentOf(type, picks, third);
          const a = g(fc.constantFrom, ...base.locales);
          const form = screenForm(base, a);
          for (const name of Object.keys(form)) {
            if (!ofLocale(name, a)) continue;
            if (name.endsWith('.mode')) {
              form[name] = g(fc.constantFrom, 'inherit', 'hide', 'own');
              continue;
            }
            const edit = g(fc.constantFrom, 'keep', 'type', 'empty');
            if (edit === 'type') form[name] = g(fc.stringMatching, /^[A-Za-z][A-Za-z ]{0,15}$/);
            if (edit === 'empty') form[name] = '';
          }
          const data = formData(form);
          const { document } = formDocument(
            base,
            valuesFromForm(data),
            posted(data),
            '2026-10-30',
            a
          );
          expect(document.locales).toEqual(base.locales);
          for (const b of base.locales.filter((l) => l !== a))
            expect(valuesIn(document, b), `locale ${b} after editing ${a}`).toEqual(
              valuesIn(base, b)
            );
        }
      ),
      { numRuns: 300 }
    );
  });

  it('keeps a list row whose shown locale is emptied while another locale has text', () => {
    const faq = examples.findIndex((e) => e.type === 'faq');
    const base = documentOf('page', [faq], false);
    const form = screenForm(base, 'nl');
    for (const k of Object.keys(form))
      if (/^b\.b0\.p\.entries\.0\./.test(k) && k.endsWith('.nl')) form[k] = '';
    const data = formData(form);
    const { document } = formDocument(base, valuesFromForm(data), posted(data), '2026-10-30', 'nl');
    const before = (base.blocks[0]!.props as { entries: Record<string, Record<string, unknown>>[] })
      .entries;
    const after = (
      document.blocks[0]!.props as { entries: Record<string, Record<string, unknown>>[] }
    ).entries;
    expect(after).toHaveLength(before.length);
    expect(after[0]!['question']).toEqual({ en: before[0]!['question']!['en'] });
  });

  it('reads no locale at all for a form opened on a locale the document lacks', () => {
    const base = documentOf('page', [0, 1, 2], false);
    const form = screenForm(base, 'de');
    form['editLocale'] = '';
    const data = formData(form);
    const { document } = formDocument(base, valuesFromForm(data), posted(data), '2026-10-30', null);
    for (const b of base.locales) expect(valuesIn(document, b)).toEqual(valuesIn(base, b));
  });
});

describe('withLocale', () => {
  it('adds a locale empty or as a copy of another, and never changes the others', () => {
    const base = documentOf('article', [0, 3, 5, 8], false);
    const empty = withLocale(base, 'de', null);
    expect(empty.locales).toEqual(['nl', 'en', 'de']);
    expect(valuesIn(empty, 'de')).toEqual([]);
    const copy = withLocale(base, 'de', 'nl');
    expect(valuesIn(copy, 'de')).toEqual(valuesIn(base, 'nl'));
    for (const l of base.locales) expect(valuesIn(copy, l)).toEqual(valuesIn(base, l));
    expect(valuesIn(base, 'de')).toEqual([]);
  });
});
