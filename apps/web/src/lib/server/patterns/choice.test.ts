// The pattern choice shared by `content/new` and the empty column: what each offers and
// which blocks the standard long read gives, without a database. Rejected: covering this only
// through e2e, where a page that wrongly offers the long read shows up as one missing option.
import { describe, expect, it } from 'vitest';
import { UseCaseError, longReadPattern, systemPrincipal } from '@mycel/core';
import { LONG_READ, choicesOf, chosenBlocks, standardBlocks } from './choice.js';

const PATTERNS: Parameters<typeof choicesOf>[0] = [
  { id: 'p1', name: { nl: 'Campagne', en: 'Campaign' }, intendedType: 'page' },
  { id: 'a1', name: { en: 'Interview' }, intendedType: 'article' },
];

describe('choicesOf', () => {
  it('offers the long read first for an article and never for a page', () => {
    expect(choicesOf([], 'article', ['nl']).longRead).toBe(LONG_READ);
    expect(choicesOf([], 'page', ['nl']).longRead).toBeNull();
  });

  it('groups every typed pattern by its type for a new item', () => {
    expect(choicesOf(PATTERNS, 'page', ['nl', 'en']).own).toEqual([
      { id: 'p1', type: 'page', name: 'Campagne' },
      { id: 'a1', type: 'article', name: 'Interview' },
    ]);
  });

  it("keeps only the item's own type in the empty column, named in any locale it has", () => {
    expect(choicesOf(PATTERNS, 'article', ['nl'], true).own).toEqual([
      { id: 'a1', type: 'article', name: 'Interview' },
    ]);
  });
});

describe('standardBlocks', () => {
  it("builds the long read in the item's locales, without block ids", () => {
    const blocks = standardBlocks(LONG_READ, 'article', ['nl', 'en'])!;
    expect(blocks.map((b) => b.type)).toEqual(['rich-text', 'quote', 'rich-text']);
    expect(blocks.every((b) => !('id' in b))).toBe(true);
    const quote = blocks[1]!.props as { text: Record<string, string> };
    expect(Object.keys(quote.text).sort()).toEqual(['en', 'nl']);
    expect(blocks).toEqual(longReadPattern(['nl', 'en']).blocks);
  });

  it('gives nothing for a page, without locales or for a saved pattern', () => {
    expect(standardBlocks(LONG_READ, 'page', ['nl'])).toBeNull();
    expect(standardBlocks(LONG_READ, 'article', [])).toBeNull();
    expect(standardBlocks('p1', 'article', ['nl'])).toBeNull();
  });
});

describe('chosenBlocks', () => {
  it('refuses the long read on a page before any pattern is read', async () => {
    const principal = systemPrincipal('01900000-0000-7000-8000-000000000001', 'test');
    await expect(chosenBlocks(principal, LONG_READ, 'page', ['nl'])).rejects.toBeInstanceOf(
      UseCaseError
    );
  });
});
