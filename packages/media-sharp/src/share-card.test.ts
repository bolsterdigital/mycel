// The share card against a real satori and sharp: a 1200x630 PNG without metadata, the title
// drawn in the site's font on its colour, the photo cropped into its column and the logo placed.
// `SHARE_CARD_OUT=<dir>` writes the cards there, for a reviewer to look at (the brief asks for
// visual proof in the PR, not in the repository).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { SHARE_CARD_HEIGHT, SHARE_CARD_WIDTH, type ShareCardDrawing } from '@mycel/core';
import { createSharpProcessor } from './index.js';

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url)).then((b) => new Uint8Array(b));
const processor = createSharpProcessor();

async function draw(name: string, card: ShareCardDrawing) {
  const png = await processor.shareCard(card);
  const out = process.env.SHARE_CARD_OUT;
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(`${out}/${name}.png`, png);
  }
  return png;
}

const base: ShareCardDrawing = {
  title: 'Zo onderzochten we de pepernoten',
  font: 'inter',
  background: '#123456',
  foreground: '#ffffff',
  photo: null,
  logo: null,
};

describe('share card', () => {
  it('is a 1200x630 PNG without metadata, in the background colour', async () => {
    const png = await draw('plain', base);
    const meta = await sharp(png).metadata();
    expect(meta).toMatchObject({
      format: 'png',
      width: SHARE_CARD_WIDTH,
      height: SHARE_CARD_HEIGHT,
    });
    expect(meta.exif).toBeUndefined();
    // A corner far from the text is the primary background.
    const { data } = await sharp(png)
      .extract({ left: 1190, top: 10, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([0x12, 0x34, 0x56]);
  });

  it('draws the title: the text area differs from an empty card', async () => {
    const titled = await sharp(await draw('titled', base))
      .raw()
      .toBuffer();
    const empty = await sharp(await processor.shareCard({ ...base, title: ' ' }))
      .raw()
      .toBuffer();
    expect(titled.equals(empty)).toBe(false);
  });

  it('puts the photo in the right-hand column and a logo at the bottom', async () => {
    const photo = await fixture('exif-orientation-gps.jpg');
    const logo = await sharp({
      create: { width: 200, height: 80, channels: 4, background: '#ff0000' },
    })
      .webp()
      .toBuffer();
    const png = await draw('photo-logo', {
      ...base,
      title:
        'Een veel langere titel die over meerdere regels loopt en toch leesbaar moet blijven op een klein kaartje in een tijdlijn',
      font: 'source-serif-inter',
      photo: { bytes: photo, focal: { x: 0.5, y: 0.5 } },
      logo: new Uint8Array(logo),
    });
    const pixel = async (left: number, top: number) => {
      const { data } = await sharp(png)
        .extract({ left, top, width: 1, height: 1 })
        .raw()
        .toBuffer({ resolveWithObject: true });
      return [...data.subarray(0, 3)];
    };
    expect(await pixel(1000, 300)).not.toEqual([0x12, 0x34, 0x56]);
    // The logo's red, inside its box at the bottom left.
    const [r, g, b] = await pixel(100, 630 - 72 - 20);
    expect(r).toBeGreaterThan(240);
    expect(g! + b!).toBeLessThan(16);
  });
});
