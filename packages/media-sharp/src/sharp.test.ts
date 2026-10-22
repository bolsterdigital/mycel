// The ImageProcessor contract against a real sharp, from committed fixtures
// (`fixtures/make-fixtures.mjs` says how they were made). What matters most: a rendered file
// carries no EXIF at all (a GPS position must not survive an upload), the orientation is applied
// before that, and a decompression bomb is refused without being decoded.

import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_PIXELS } from '@mycel/core';
import { createSharpProcessor } from './index.js';

const fixture = (name: string) =>
  readFile(new URL(`../fixtures/${name}`, import.meta.url)).then((b) => new Uint8Array(b));

/** The tags of IFD0 and of the GPS IFD in a JPEG's EXIF segment; null when there is none. */
function exifTags(jpeg: Uint8Array): { ifd0: number[]; gps: number[] } | null {
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  for (let at = 2; at + 4 < jpeg.length;) {
    const marker = view.getUint16(at);
    const length = view.getUint16(at + 2);
    if (marker === 0xffe1 && String.fromCharCode(...jpeg.subarray(at + 4, at + 8)) === 'Exif') {
      const tiff = at + 10;
      const le = view.getUint16(tiff) === 0x4949;
      const u16 = (o: number) => view.getUint16(tiff + o, le);
      const u32 = (o: number) => view.getUint32(tiff + o, le);
      const tags = (ifd: number) =>
        Array.from({ length: u16(ifd) }, (_, i) => u16(ifd + 2 + i * 12));
      const ifd0 = tags(u32(4));
      const gpsEntry = ifd0.indexOf(0x8825);
      const gps = gpsEntry < 0 ? [] : tags(u32(u32(4) + 2 + gpsEntry * 12 + 8));
      return { ifd0, gps };
    }
    if (marker === 0xffda) break;
    at += 2 + length;
  }
  return null;
}

describe('sharp ImageProcessor', () => {
  const processor = createSharpProcessor();

  it('the fixture really carries an orientation, a camera make and a GPS position', async () => {
    const tags = exifTags(await fixture('exif-orientation-gps.jpg'));
    expect(tags?.ifd0).toEqual(expect.arrayContaining([0x010f, 0x0112, 0x8825]));
    expect(tags?.gps).toEqual(expect.arrayContaining([1, 2, 3, 4]));
  });

  it('probes the size a viewer sees: after the EXIF orientation', async () => {
    expect(await processor.probe(await fixture('exif-orientation-gps.jpg'))).toEqual({
      format: 'jpeg',
      width: 20,
      height: 40,
    });
  });

  it('renders with the orientation applied and no metadata left', async () => {
    const source = await fixture('exif-orientation-gps.jpg');
    for (const format of ['jpeg', 'webp', 'avif'] as const) {
      const out = await processor.render(source, { width: 20, format, stripMetadata: true });
      expect(out).toMatchObject({ width: 20, height: 40 });
      const meta = await sharp(out.bytes).metadata();
      expect(meta, format).toMatchObject({ width: 20, height: 40 });
      expect(meta.orientation ?? 1, format).toBe(1);
      expect(meta.exif, `${format} keeps EXIF`).toBeUndefined();
      expect(meta.xmp, `${format} keeps XMP`).toBeUndefined();
      expect(meta.icc, `${format} keeps an ICC profile`).toBeUndefined();
    }
    const jpeg = await processor.render(source, { width: 20, format: 'jpeg', stripMetadata: true });
    expect(exifTags(jpeg.bytes)).toBeNull();
    // Turned clockwise: the red left half of the stored pixels is now the top.
    const { data } = await sharp(jpeg.bytes).raw().toBuffer({ resolveWithObject: true });
    const [r, , b] = [data[0]!, data[1]!, data[2]!];
    expect(r).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
  });

  it('scales down to the requested width and never up', async () => {
    const source = await fixture('exif-orientation-gps.jpg');
    expect(
      await processor.render(source, { width: 10, format: 'webp', stripMetadata: true })
    ).toMatchObject({ width: 10, height: 20 });
    expect(
      await processor.render(source, { width: 640, format: 'webp', stripMetadata: true })
    ).toMatchObject({ width: 20, height: 40 });
  });

  it('recognises each accepted format by its content, and nothing else', async () => {
    const base = sharp({ create: { width: 4, height: 3, channels: 3, background: '#0a0' } });
    for (const format of ['png', 'webp', 'avif', 'gif', 'jpeg'] as const) {
      const bytes = new Uint8Array(await base.clone().toFormat(format).toBuffer());
      expect(await processor.probe(bytes), format).toEqual({ format, width: 4, height: 3 });
    }
    expect(await processor.probe(new TextEncoder().encode('<svg xmlns="x"/>'))).toBeNull();
    expect(await processor.probe(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
  });

  it('reads the size of a decompression bomb from its header and refuses to decode it', async () => {
    const bomb = await fixture('bomb.png');
    expect(bomb.length).toBeLessThan(64 * 1024);
    const probe = await processor.probe(bomb);
    expect(probe).toEqual({ format: 'png', width: 8000, height: 8000 });
    expect(probe!.width * probe!.height).toBeGreaterThan(MAX_PIXELS);
    await expect(
      processor.render(bomb, { width: 320, format: 'webp', stripMetadata: true })
    ).rejects.toThrow(/pixel limit/i);
  });
});
