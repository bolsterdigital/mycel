import { describe, expect, it } from 'vitest';
import { ContentDocument } from '../model.js';
import {
  MAX_SEARCH_TOKENS,
  matchesSearch,
  queryTokens,
  searchEntry,
  searchExcerpt,
  searchOpens,
  searchReaderOf,
  searchTexts,
  searchTokens,
} from './search.js';

const TIER = '01900000-0000-7000-8000-00000000a001';

const doc = (over: Record<string, unknown> = {}) =>
  ContentDocument.parse({
    type: 'page',
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    title: { nl: 'Het café', en: 'The pub' },
    lead: { nl: 'Open op zondag.', en: 'Open on Sunday.' },
    blocks: [
      {
        id: 'b1',
        type: 'rich-text',
        version: 1,
        props: {
          content: {
            nl: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Eerste alinea.' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'Tweede alinea.' }] },
              ],
            },
          },
        },
      },
    ],
    ...over,
  });

describe('search tokens', () => {
  it('folds case and accents and splits on everything that is no letter or digit', () => {
    expect(searchTokens('Café-bezoek: Ångström, 2024/11 ﬁets')).toEqual([
      'cafe',
      'bezoek',
      'angstrom',
      '2024',
      '11',
      'fiets',
    ]);
  });

  it('keeps the distinct tokens of a question that are long enough, up to the cap', () => {
    expect(queryTokens(' a De de x fiets ')).toEqual(['de', 'fiets']);
    const many = Array.from({ length: 12 }, (_, i) => `woord${i}`).join(' ');
    expect(queryTokens(many)).toHaveLength(MAX_SEARCH_TOKENS);
  });
});

describe('search entry', () => {
  it('holds one locale: title, lead and block text, with rich-text blocks apart', () => {
    expect(searchTexts(doc(), 'nl')).toEqual({
      title: 'Het café',
      body: ['Open op zondag.', 'Eerste alinea. Tweede alinea.'],
    });
    const entry = searchEntry(doc(), 'nl')!;
    expect(entry.title).toEqual(['het', 'cafe']);
    expect(entry.all).toContain('tweede');
    expect(searchEntry(doc(), 'en')!.all).not.toContain('tweede');
  });

  it('gives nothing to find a noindex revision by', () => {
    expect(searchEntry(doc({ seo: { noindex: true } }), 'nl')).toBeNull();
  });

  it('gives a restricted revision its teaser tokens apart, with its access', () => {
    const entry = searchEntry(doc({ access: { level: 'tier', tierIds: [TIER] } }), 'nl')!;
    expect(entry.teaser).toEqual(['het', 'cafe', 'open', 'op', 'zondag']);
    expect(entry.all).toContain('tweede');
    expect(entry.access).toEqual({ level: 'tier', tierIds: [TIER] });
    expect(searchEntry(doc(), 'nl')!.teaser).toBeNull();
  });

  it('matches the whole text only for a reader the entry opens to, the teaser for everyone', () => {
    const members = searchEntry(doc({ access: { level: 'members' } }), 'nl')!;
    const tier = searchEntry(doc({ access: { level: 'tier', tierIds: [TIER] } }), 'nl')!;
    const nobody = { tierIds: [] };
    expect(matchesSearch(members, ['tweede'])).toBeNull();
    expect(matchesSearch(members, ['tweede'], nobody)).toEqual({ inTitle: false });
    expect(matchesSearch(members, ['zondag'])).toEqual({ inTitle: false });
    expect(matchesSearch(tier, ['tweede'], nobody)).toBeNull();
    expect(matchesSearch(tier, ['tweede'], { tierIds: [TIER] })).toEqual({ inTitle: false });
    expect(matchesSearch(tier, ['cafe'])).toEqual({ inTitle: true });
    expect(searchOpens({ level: 'tier', tierIds: [] }, { tierIds: [TIER] })).toBe(false);
  });

  it('reads the tiers a reader stands in now, the end of a grant exclusive', () => {
    const now = new Date('2026-11-17T12:00:00Z');
    const grants = [
      { tierId: 'a', until: null },
      { tierId: 'b', until: '2026-11-17T12:00:00Z' },
      { tierId: 'c', until: '2026-11-18T00:00:00Z' },
    ];
    expect(searchReaderOf({ grants }, now)).toEqual({ tierIds: ['a', 'c'] });
    expect(searchReaderOf(null, now)).toBeNull();
  });

  it('matches when every token starts a word, and says whether the title carries them all', () => {
    const entry = searchEntry(doc(), 'nl')!;
    expect(matchesSearch(entry, ['caf'])).toEqual({ inTitle: true });
    expect(matchesSearch(entry, ['caf', 'zon'])).toEqual({ inTitle: false });
    expect(matchesSearch(entry, ['caf', 'maandag'])).toBeNull();
    expect(matchesSearch(entry, ['afe'])).toBeNull();
    expect(matchesSearch(entry, [])).toBeNull();
  });
});

describe('search excerpt', () => {
  it('marks the matching words of the first text that has one', () => {
    expect(searchExcerpt(['Open op zondag.', 'Eerste alinea.'], ['alin'])).toEqual([
      { text: 'Eerste ', match: false },
      { text: 'alinea', match: true },
      { text: '.', match: false },
    ]);
  });

  it('starts at the first text when only the title matched, and is empty without text', () => {
    expect(searchExcerpt(['Open op zondag.'], ['cafe'])).toEqual([
      { text: 'Open op zondag.', match: false },
    ]);
    expect(searchExcerpt([], ['cafe'])).toEqual([]);
  });

  it('cuts a long text at words around the match', () => {
    const long = `${'woord '.repeat(60)}fietspad ${'woord '.repeat(60)}`.trim();
    const excerpt = searchExcerpt([long], ['fiets']);
    const text = excerpt.map((s) => s.text).join('');
    expect(text.length).toBeLessThan(200);
    expect(text.startsWith('… woord')).toBe(true);
    expect(text.endsWith('woord …')).toBe(true);
    expect(excerpt.filter((s) => s.match).map((s) => s.text)).toEqual(['fietspad']);
  });
});
