// The pattern choice shared by `content/new` and the empty column: what each offers and
// which blocks the standard long read gives, without a database. Rejected: covering this only
// through e2e, where a page that wrongly offers the long read shows up as one missing option.
import { describe, expect, it } from 'vitest';
import { UseCaseError, longReadPattern, photoStoryPattern, systemPrincipal } from '@mycel/core';
import { LONG_READ, PHOTO_STORY, choicesOf, chosenBlocks, standardBlocks } from './choice.js';
import { PHOTO_SLOTS, storyPhotos } from './photo-story.js';

const PHOTO = '01900000-0000-7000-8000-0000000000a1';
const OTHER = '01900000-0000-7000-8000-0000000000a2';

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

  it('offers the photo story for an article in content/new only', () => {
    expect(choicesOf([], 'article', ['nl']).photoStory).toBe(PHOTO_STORY);
    expect(choicesOf([], 'article', ['nl'], true).photoStory).toBeNull();
    expect(choicesOf([], 'page', ['nl']).photoStory).toBeNull();
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

describe('photo story', () => {
  it('reads the chosen slots in order and skips the empty ones', () => {
    const { photos, problem } = storyPhotos(
      {
        'photo.0.mediaId': PHOTO,
        'photo.0.alt.nl': ' Een plein ',
        'photo.0.alt.en': 'A square',
        'photo.1.mediaId': '',
        'photo.2.mediaId': OTHER,
        'photo.2.decorative': 'on',
        'photo.2.alt.nl': 'genegeerd',
      },
      ['nl', 'en']
    );
    expect(problem).toBeNull();
    expect(photos).toEqual([
      { mediaId: PHOTO, decorative: false, alt: { nl: 'Een plein', en: 'A square' } },
      { mediaId: OTHER, decorative: true, alt: null },
    ]);
  });

  it('says what is missing: no photo at all, or a description in one locale', () => {
    expect(storyPhotos({}, ['nl']).problem).toBe('none');
    const half = { 'photo.0.mediaId': PHOTO, 'photo.0.alt.nl': 'Plein' };
    expect(storyPhotos(half, ['nl', 'en']).problem).toBe('alt');
    expect(storyPhotos(half, ['nl']).problem).toBeNull();
  });

  it('never reads more than the form offers', () => {
    const values = {
      [`photo.${PHOTO_SLOTS}.mediaId`]: PHOTO,
      [`photo.${PHOTO_SLOTS}.decorative`]: 'on',
    };
    expect(storyPhotos(values, ['nl']).problem).toBe('none');
  });

  it("builds core's photo story without block ids, and nothing without photos", () => {
    const photos = storyPhotos(
      {
        'photo.0.mediaId': PHOTO,
        'photo.0.alt.nl': 'Plein',
        'photo.1.mediaId': OTHER,
        'photo.1.decorative': 'on',
      },
      ['nl']
    ).photos;
    const blocks = standardBlocks(PHOTO_STORY, 'article', ['nl'], photos)!;
    expect(blocks.map((b) => b.type)).toEqual(['image', 'rich-text', 'image', 'rich-text']);
    expect(blocks).toEqual(photoStoryPattern(photos, ['nl']).blocks);
    expect(blocks[0]!.props).toMatchObject({
      mediaId: PHOTO,
      alt: { nl: 'Plein' },
      layout: 'full',
    });
    expect(standardBlocks(PHOTO_STORY, 'article', ['nl'])).toBeNull();
    expect(standardBlocks(PHOTO_STORY, 'page', ['nl'], photos)).toBeNull();
  });
});

describe('chosenBlocks', () => {
  it('refuses the long read on a page before any pattern is read', async () => {
    const principal = systemPrincipal('01900000-0000-7000-8000-000000000001', 'test');
    await expect(chosenBlocks(principal, LONG_READ, 'page', ['nl'])).rejects.toBeInstanceOf(
      UseCaseError
    );
    await expect(chosenBlocks(principal, PHOTO_STORY, 'article', ['nl'])).rejects.toBeInstanceOf(
      UseCaseError
    );
  });
});
