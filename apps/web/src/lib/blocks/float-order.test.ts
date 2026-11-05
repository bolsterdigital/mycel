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

  it('moves a text that is only a heading above the float whole, and the next opening too', () => {
    const only = text(heading);
    expect(headingsAboveFloats([float(), only])).toEqual([only, float()]);
    const next = { ...text(heading, paragraph), id: 'y' } as RenderBlock;
    const ids = headingsAboveFloats([float(), only, next]).map((b) => b.id);
    expect(ids).toEqual(['txt', 'y-opening', 'img', 'y']);
    const after = { ...text(paragraph), id: 'y' } as RenderBlock;
    expect(headingsAboveFloats([float(), only, after]).map((b) => b.id)).toEqual([
      'txt',
      'img',
      'y',
    ]);
  });

  it('puts the heading above a run of floats, which keep their order', () => {
    const a = { ...float(), id: 'a' } as RenderBlock;
    const b = { ...float('float-left'), id: 'b' } as RenderBlock;
    const h = { id: 'h', type: 'heading', text: 'x' } as RenderBlock;
    const ids = (blocks: RenderBlock[]) => headingsAboveFloats(blocks).map((x) => x.id);
    expect(ids([a, b, text(heading, paragraph)])).toEqual(['txt-opening', 'a', 'b', 'txt']);
    expect(ids([a, b, h, text(paragraph)])).toEqual(['h', 'a', 'b', 'txt']);
  });

  it('lets a float after the collected headings join the run, so no float precedes a heading', () => {
    const a = { ...float(), id: 'a' } as RenderBlock;
    const b = { ...float('float-left'), id: 'b' } as RenderBlock;
    const h = { id: 'h', type: 'heading', text: 'x' } as RenderBlock;
    const ids = (blocks: RenderBlock[]) => headingsAboveFloats(blocks).map((x) => x.id);
    expect(ids([a, h, b, text(heading, paragraph)])).toEqual(['h', 'txt-opening', 'a', 'b', 'txt']);
    const only = { ...text(heading), id: 'only' } as RenderBlock;
    expect(ids([a, only, b, text(heading, paragraph)])).toEqual([
      'only',
      'txt-opening',
      'a',
      'b',
      'txt',
    ]);
    expect(ids([a, h, b, text(paragraph)])).toEqual(['h', 'a', 'b', 'txt']);
  });

  it('splits every heading a text opens with, and leaves an empty text where it is', () => {
    const sub = { ...heading, attrs: { level: 2 } };
    const [opening, , rest] = headingsAboveFloats([float(), text(heading, sub, paragraph)]);
    expect(opening).toMatchObject({ doc: { content: [heading, sub] } });
    expect(rest).toMatchObject({ doc: { content: [paragraph] } });
    const empty = [float(), text()];
    expect(headingsAboveFloats(empty)).toEqual(empty);
  });
});
