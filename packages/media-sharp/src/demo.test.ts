// The demo renderer draws what the seed asks for: a PNG of the requested size that the sharp
// processor accepts, so `media.upload` takes it like any other upload.

import { describe, expect, it } from 'vitest';
import { renderLabelImage } from './demo.js';
import { createSharpProcessor } from './sharp.js';

describe('renderLabelImage', () => {
  it.each([
    [1600, 900],
    [900, 1200],
  ])('renders a %ix%i PNG', async (width, height) => {
    const bytes = await renderLabelImage({
      width,
      height,
      label: 'Proeverij <op> de markt & meer',
      colors: ['#1f6f5c', '#0b2e4a'],
    });
    expect(await createSharpProcessor().probe(bytes)).toEqual({
      format: 'png',
      width,
      height,
      pages: 1,
    });
  });

  it('refuses a colour that is not #rrggbb', async () => {
    await expect(
      renderLabelImage({ width: 10, height: 10, label: 'x', colors: ['red"/>', '#000000'] })
    ).rejects.toThrow('#rrggbb');
  });
});
