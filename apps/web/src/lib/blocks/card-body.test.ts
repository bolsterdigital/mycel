// The word limit under which a full campaign card shows the campaign's text open (ADR 038 rule
// 4): the constant, and that a subheading folds the text whatever its length.
import { describe, expect, it } from 'vitest';
import { CARD_BODY_OPEN_WORDS, opensInCard } from './card-body.js';
import type { RenderBlock } from './model.js';

const text = (words: number): RenderBlock => ({
  id: 't',
  type: 'rich-text',
  doc: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'woord '.repeat(words) }] }],
  },
});

describe('opensInCard', () => {
  it('opens up to the limit of 80 words, folds above it', () => {
    expect(CARD_BODY_OPEN_WORDS).toBe(80);
    expect(opensInCard([text(80)])).toBe(true);
    expect(
      opensInCard([
        text(40),
        {
          id: 'q',
          type: 'quote',
          variant: 'blockquote',
          width: 'content',
          text: 'een twee',
          name: '',
          role: null,
          source: null,
          url: null,
        },
      ] as RenderBlock[])
    ).toBe(true);
    expect(opensInCard([text(81)])).toBe(false);
  });

  it('folds a text with a subheading, as a block or inside the text', () => {
    expect(opensInCard([{ id: 'h', type: 'heading', text: 'Kop' }, text(3)])).toBe(false);
    const inText: RenderBlock = {
      id: 't',
      type: 'rich-text',
      doc: {
        type: 'doc',
        content: [
          { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Kop' }] },
        ],
      },
    };
    expect(opensInCard([inText])).toBe(false);
  });
});
