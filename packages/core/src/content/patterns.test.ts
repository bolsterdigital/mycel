// The standard long read is built per request for the locales an item starts with (the admin's
// new-article form sends its blocks, not a saved pattern), so every localised value must carry
// exactly those locales and nothing else. Saving and applying the factories against a database
// is covered in media-references.test.ts.
import { describe, expect, it } from 'vitest';
import { longReadPattern } from './patterns.js';

const localeKeys = (blocks: ReturnType<typeof longReadPattern>['blocks']) =>
  blocks.map((b) => {
    const props = b.props as Record<string, unknown>;
    const map = (props.content ?? props.text) as Record<string, unknown>;
    return Object.keys(map).sort();
  });

describe('longReadPattern', () => {
  it('is prose, a pull quote and prose, meant for an article', () => {
    const p = longReadPattern();
    expect(p.intendedType).toBe('article');
    expect(p.blocks.map((b) => b.type)).toEqual(['rich-text', 'quote', 'rich-text']);
    expect(localeKeys(p.blocks)).toEqual([
      ['en', 'nl'],
      ['en', 'nl'],
      ['en', 'nl'],
    ]);
  });

  it('carries only the requested locales, with the copy of each', () => {
    const nl = longReadPattern(['nl']);
    expect(localeKeys(nl.blocks)).toEqual([['nl'], ['nl'], ['nl']]);
    expect((nl.blocks[1]!.props as { text: Record<string, string> }).text.nl).toBe(
      'Een zin uit het verhaal die de lezer verder laat lezen.'
    );

    const en = longReadPattern(['en']);
    expect(localeKeys(en.blocks)).toEqual([['en'], ['en'], ['en']]);
    expect((en.blocks[1]!.props as { text: Record<string, string> }).text.en).toBe(
      'A sentence from the story that makes the reader want to read on.'
    );
  });

  it('gives its blocks no id, so applying it never reuses one', () => {
    expect(longReadPattern(['nl']).blocks.every((b) => !('id' in b) || b.id === undefined)).toBe(
      true
    );
  });
});
