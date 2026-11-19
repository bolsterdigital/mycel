// The generated share card: a 1200x630 PNG with the item's title in the site's heading
// font on its primary colour, at most one logo, and the item's public photo beside it. satori
// lays out the text (line breaks, clamping) and turns every glyph into a path, so the SVG it
// returns needs no font at rasterisation; sharp then crops the photo to the focal point and
// composites both. Nothing here reads a URL: the core hands over bytes it already checked.
//
// Rejected: a headless browser (a process and a network surface per card), text through
// librsvg (fonts would come from the container's fontconfig, so the card would differ per host)
// and @resvg/resvg-js (a second native rasteriser beside libvips for the same job).

import { readFileSync } from 'node:fs';
import satori from 'satori';
import sharp from 'sharp';
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  type FontKey,
  type ShareCardDrawing,
} from '@mycel/core';

/**
 * The heading font per catalogue key, drawn at its regular weight: a static instance renamed
 * `Mycel Card`, because satori draws a variable font at its default instance (Raleway's is Thin)
 * and a modified face may not carry a Reserved Font Name (docs/reference/fonts.md).
 */
const CARD_FAMILY = 'Mycel Card';
const fonts = new Map<FontKey, Buffer>();
const font = (key: FontKey): Buffer => {
  let found = fonts.get(key);
  if (!found) {
    found = readFileSync(new URL(`../fonts/${key}/card.woff2`, import.meta.url));
    fonts.set(key, found);
  }
  return found;
};

/** The photo's share of the width; the title keeps the rest, so it stays readable at 200 px. */
const PHOTO_WIDTH = 480;
const PAD = 72;
const LOGO_HEIGHT = 72;

/** Fewer characters, larger type: a short title fills the card, a long one still fits. */
const sizeFor = (title: string) => (title.length <= 40 ? 76 : title.length <= 90 ? 62 : 50);

type Node = { type: string; props: Record<string, unknown> };
const el = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({
  type,
  props: { style, ...(children === undefined ? {} : { children }) },
});

export async function renderShareCard(card: ShareCardDrawing): Promise<Uint8Array> {
  const photo = card.photo ? await crop(card.photo.bytes, card.photo.focal) : null;
  const logo = card.logo
    ? await sharp(card.logo, { limitInputPixels: 4_000_000 })
        .resize({ height: LOGO_HEIGHT, width: 360, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true })
    : null;
  const textWidth = SHARE_CARD_WIDTH - (photo ? PHOTO_WIDTH : 0);
  const size = sizeFor(card.title);
  const tree = el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      // satori adds the padding to the size (content-box), so the box is the card minus it.
      width: textWidth - 2 * PAD,
      height: SHARE_CARD_HEIGHT - 2 * PAD,
      padding: PAD,
      backgroundColor: card.background,
      color: card.foreground,
    },
    [
      el(
        'div',
        {
          display: 'block',
          width: textWidth - 2 * PAD,
          fontFamily: CARD_FAMILY,
          fontSize: size,
          lineHeight: 1.15,
          lineClamp: Math.floor((SHARE_CARD_HEIGHT - 2 * PAD - LOGO_HEIGHT - 32) / (size * 1.15)),
        },
        card.title
      ),
      logo
        ? el('div', { display: 'flex' }, [
            {
              type: 'img',
              props: {
                src: `data:image/png;base64,${logo.data.toString('base64')}`,
                width: logo.info.width,
                height: logo.info.height,
              },
            },
          ])
        : el('div', { display: 'flex', height: 8, width: 96, backgroundColor: card.foreground }),
    ]
  );
  const svg = await satori(tree as Parameters<typeof satori>[0], {
    width: textWidth,
    height: SHARE_CARD_HEIGHT,
    fonts: [{ name: CARD_FAMILY, data: font(card.font), style: 'normal' }],
  });
  const text = await sharp(Buffer.from(svg)).png().toBuffer();
  const png = await sharp({
    create: {
      width: SHARE_CARD_WIDTH,
      height: SHARE_CARD_HEIGHT,
      channels: 3,
      background: card.background,
    },
  })
    .composite([
      { input: text, left: 0, top: 0 },
      ...(photo ? [{ input: photo, left: textWidth, top: 0 }] : []),
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  return new Uint8Array(png.buffer, png.byteOffset, png.byteLength);
}

/** The photo cut to the right-hand column around its focal point. */
async function crop(bytes: Uint8Array, focal: { x: number; y: number }): Promise<Buffer> {
  const image = sharp(bytes, { limitInputPixels: 50_000_000 }).autoOrient();
  const { width = 1, height = 1 } = await image.metadata();
  const scale = Math.max(PHOTO_WIDTH / width, SHARE_CARD_HEIGHT / height);
  const w = Math.max(PHOTO_WIDTH, Math.round(width * scale));
  const h = Math.max(SHARE_CARD_HEIGHT, Math.round(height * scale));
  const clamp = (v: number, max: number) => Math.min(Math.max(0, Math.round(v)), max);
  return image
    .resize({ width: w, height: h })
    .extract({
      left: clamp(focal.x * w - PHOTO_WIDTH / 2, w - PHOTO_WIDTH),
      top: clamp(focal.y * h - SHARE_CARD_HEIGHT / 2, h - SHARE_CARD_HEIGHT),
      width: PHOTO_WIDTH,
      height: SHARE_CARD_HEIGHT,
    })
    .png()
    .toBuffer();
}
