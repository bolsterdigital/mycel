import { selectBlockName } from '../../../static/_admin/block-name.js';
// The presentation contract covers the whole registry (MY-110 A acceptance: a new type may not
// silently fall back to every property unfolded) and names only fields the registry has.
import { describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES } from '@mycel/core';
import { BLOCK_PRESENTATION, groupOf } from './block-presentation.js';

describe('block presentation', () => {
  it('has an entry for every registered block type and no other', () => {
    expect(Object.keys(BLOCK_PRESENTATION).sort()).toEqual([...BLOCK_TYPES].sort());
  });

  it.each(BLOCK_TYPES)('%s groups only top-level fields it has, each once', (type) => {
    const keys = BLOCK_DEFINITIONS[type].fields.map((f) => f.key);
    const { display, source } = BLOCK_PRESENTATION[type];
    for (const key of [...display, ...source]) expect(keys).toContain(key);
    expect(new Set([...display, ...source]).size).toBe(display.length + source.length);
    // Something stays content: a block whose editor opens on "Display" only is not editable.
    expect(keys.some((k) => groupOf(type, k) === 'content') || keys.length === 0).toBe(true);
  });

  it('shows the text blocks as their words, with the look of a quote under display', () => {
    for (const type of ['heading', 'rich-text', 'quote'] as const)
      expect(BLOCK_PRESENTATION[type]).toMatchObject({ rest: 'text', stage: 'C1' });
    expect(groupOf('quote', 'variant')).toBe('display');
    expect(groupOf('quote', 'width')).toBe('display');
    expect(groupOf('quote', 'attribution')).toBe('content');
  });

  it('shows callout, FAQ and CTA as their words, with their looks under display', () => {
    for (const type of ['callout', 'faq', 'cta'] as const)
      expect(BLOCK_PRESENTATION[type]).toMatchObject({ rest: 'text', stage: 'C2' });
    expect(groupOf('callout', 'variant')).toBe('display');
    expect(groupOf('faq', 'width')).toBe('display');
    expect(groupOf('cta', 'align')).toBe('display');
    expect(groupOf('cta', 'actions')).toBe('content');
  });

  it('shows a video and the forms at rest, with their looks under display', () => {
    for (const type of ['video-embed', 'form', 'signup-form'] as const)
      expect(BLOCK_PRESENTATION[type]).toMatchObject({ rest: 'text', stage: 'C3' });
    expect(groupOf('video-embed', 'width')).toBe('display');
    expect(groupOf('video-embed', 'provider')).toBe('content');
    expect(groupOf('form', 'variant')).toBe('display');
    expect(groupOf('form', 'formId')).toBe('content');
    expect(groupOf('signup-form', 'formId')).toBe('content');
  });

  it('leaves a paywall nothing to edit, so its card has no fold', () => {
    expect(BLOCK_DEFINITIONS.paywall.fields).toEqual([]);
  });

  it("shows the paywall and the legacy hero at rest, with the hero's looks under display", () => {
    for (const type of ['paywall', 'hero'] as const)
      expect(BLOCK_PRESENTATION[type]).toMatchObject({ rest: 'text', stage: 'C4' });
    expect(groupOf('hero', 'variant')).toBe('display');
    expect(groupOf('hero', 'align')).toBe('display');
    expect(groupOf('hero', 'title')).toBe('content');
    expect(groupOf('hero', 'image')).toBe('content');
  });

  it('shows the image pilot as a picture, with layout under display and credit as source', () => {
    expect(BLOCK_PRESENTATION.image).toMatchObject({ rest: 'image', stage: 'A' });
    expect(groupOf('image', 'layout')).toBe('display');
    expect(groupOf('image', 'credit')).toBe('source');
    expect(groupOf('image', 'caption')).toBe('content');
    expect(groupOf('image', 'alt')).toBe('content');
  });
});

describe('shared block name selection', () => {
  it.each([
    [
      {},
      [
        { en: '', nl: 'Nederlandse tekst' },
        { en: 'Author', nl: 'Auteur' },
      ],
      '',
      'Nederlandse tekst',
    ],
    [{}, [{ en: '', nl: '' }, { en: 'Author' }], '', 'Author'],
    [{}, [{ nl: 'Bijschrift' }], 'photo.jpg', 'Bijschrift'],
    [{}, [{}], 'photo.jpg', 'photo.jpg'],
    [{ nl: 'Eigen naam' }, [{ en: 'Content' }], '', 'Eigen naam'],
    [{ en: ' ', nl: ' ' }, [{ en: 'Content' }], '', 'Content'],
    [{ de: 'Dritte Sprache' }, [{ de: 'Nur Deutsch' }], '', ''],
  ] as const)('uses active/default locale only: %j', (names, candidates, file, expected) => {
    expect(selectBlockName(names, candidates, 'en', 'nl', file).name).toBe(expected);
  });
});
