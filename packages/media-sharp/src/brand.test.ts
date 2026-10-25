// Real decoders reject active SVG and malformed WOFF2 before any byte is stored.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createBrandProcessor, validateWoff2 } from './brand.js';

const utf8 = (value: string) => new TextEncoder().encode(value);
const processor = createBrandProcessor();
const svg = (inside: string) =>
  utf8(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">${inside}</svg>`);

describe('brand decoder', () => {
  it('rasterises a basic SVG and never retains source markup', async () => {
    const result = await processor.logo(
      svg('<rect width="20" height="20" fill="#123456"/>'),
      'image/svg+xml'
    );
    expect(result).toMatchObject({ contentType: 'image/webp', width: 20, height: 20 });
    expect((await sharp(result.bytes).metadata()).format).toBe('webp');
  });
  it.each([
    '<script>alert(1)</script>',
    '<foreignObject><p>bad</p></foreignObject>',
    '<image href="https://example.org/a.png"/>',
    '<image href="file:///etc/passwd"/>',
    '<rect style="fill:url(https://example.org/x)"/>',
    '<!ENTITY x SYSTEM "file:///etc/passwd">',
  ])('rejects unsafe SVG %s', async (input) => {
    await expect(processor.logo(svg(input), 'image/svg+xml')).rejects.toThrow(/site.brand.svg/);
  });
  it('rejects MIME mismatch and unreadable or oversized pixels', async () => {
    const png = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#fff' } })
      .png()
      .toBuffer();
    await expect(processor.logo(png, 'image/jpeg')).rejects.toThrow(/mismatch/);
    await expect(processor.logo(utf8('bad'), 'image/png')).rejects.toThrow(/unreadable/);
    const header = Buffer.from(png);
    header.writeUInt32BE(100000, 16);
    header.writeUInt32BE(100000, 20);
    await expect(processor.logo(header, 'image/png')).rejects.toThrow();
  });
  it('validates bounded WOFF2 structure and decompression', async () => {
    const font = await readFile(
      new URL('../../../apps/web/static/fonts/inter/inter-latin-roman.woff2', import.meta.url)
    );
    expect(() => validateWoff2(font)).not.toThrow();
    expect(() => validateWoff2(font.subarray(0, 60))).toThrow();
    const bad = Buffer.from(font);
    bad.writeUInt32BE(bad.length, 8);
    bad.fill(0, 60, 90);
    expect(() => validateWoff2(bad)).toThrow();
  });
});
