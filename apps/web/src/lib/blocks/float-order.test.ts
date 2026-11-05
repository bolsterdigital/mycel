import { describe, expect, it } from 'vitest';
import { headingsAboveFloats } from './float-order.js';
import type { RenderBlock } from './model.js';

const float = (layout = 'float-right') =>
  ({ id: 'img', type: 'image', layout, image: {} }) as unknown as RenderBlock;
const heading = { type: 'heading', attrs: { level: 1 }, content: [] };
const paragraph = { type: 'paragraph', content: [] };
const text = (...content: unknown[]) =>
  ({ id: 'txt', type: 'rich-text', doc: { type: 'doc', content } }) as unknown as RenderBlock;

describe('headingsAboveFloats', () => {
  it('splits the heading a text opens with off, above the float, keeping the source block', () => {
    const [opening, image, rest] = headingsAboveFloats([float(), text(heading, paragraph)]);
    expect(opening).toMatchObject({
      id: 'txt-opening',
      sourceId: 'txt',
      doc: { content: [heading] },
    });
    expect(image?.type).toBe('image');
    expect(rest).toMatchObject({ id: 'txt', doc: { content: [paragraph] } });
  });

  it('moves a heading block above the float', () => {
    const h = { id: 'h', type: 'heading', text: 'x' } as RenderBlock;
    expect(headingsAboveFloats([float(), h]).map((b) => b.id)).toEqual(['h', 'img']);
  });

  it('leaves a float before running text, a block image and an image that did not resolve', () => {
    const plain = [float(), text(paragraph)];
    expect(headingsAboveFloats(plain)).toEqual(plain);
    const wide = [float('wide'), text(heading, paragraph)];
    expect(headingsAboveFloats(wide)).toEqual(wide);
    const gone = [{ ...float(), image: null } as RenderBlock, text(heading, paragraph)];
    expect(headingsAboveFloats(gone)).toEqual(gone);
  });

  it('keeps a text that is only a heading whole, with nothing to stand beside', () => {
    const only = [float(), text(heading)];
    expect(headingsAboveFloats(only)).toEqual(only);
  });
});
