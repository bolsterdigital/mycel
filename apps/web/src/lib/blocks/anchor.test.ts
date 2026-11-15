import { describe, expect, it } from 'vitest';
import { anchorIds, blockAnchor } from './anchor.js';
import { headingsAboveFloats } from './float-order.js';
import type { RenderBlock } from './model.js';

const block = (id: string, type = 'heading') => ({ id, type, text: 'x' }) as RenderBlock;
const heading = { type: 'heading', attrs: { level: 1 }, content: [] };
const paragraph = { type: 'paragraph', content: [] };

describe('anchorIds', () => {
  it('gives every block its id behind the prefix, which a page id cannot take', () => {
    const ids = anchorIds([block('intro'), block('public-main'), block('site-bar-0')]);
    expect([...ids.values()]).toEqual(['block-intro', 'block-public-main', 'block-site-bar-0']);
    expect(blockAnchor('public-main')).not.toBe('public-main');
  });

  it('gives a paywall no id', () => {
    const ids = anchorIds([block('a'), { id: 'p', type: 'paywall' }, block('b')]);
    expect(ids.has('p')).toBe(false);
    expect(ids.get('b')).toBe('block-b');
  });

  it('puts the source id of a split text on its first piece only', () => {
    const float = { id: 'img', type: 'image', layout: 'float-right', image: {} } as RenderBlock;
    const text = {
      id: 'txt',
      type: 'rich-text',
      doc: { type: 'doc', content: [heading, paragraph] },
    } as unknown as RenderBlock;
    const split = headingsAboveFloats([float, text]);
    expect(split.map((b) => b.id)).toEqual(['txt-opening', 'img', 'txt']);
    const ids = anchorIds(split);
    expect(ids.get('txt-opening')).toBe('block-txt');
    expect(ids.get('img')).toBe('block-img');
    expect(ids.has('txt')).toBe(false);
  });
});
