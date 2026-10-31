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

  it('shows the image pilot as a picture, with layout under display and credit as source', () => {
    expect(BLOCK_PRESENTATION.image).toMatchObject({ rest: 'image', stage: 'A' });
    expect(groupOf('image', 'layout')).toBe('display');
    expect(groupOf('image', 'credit')).toBe('source');
    expect(groupOf('image', 'caption')).toBe('content');
    expect(groupOf('image', 'alt')).toBe('content');
  });
});
