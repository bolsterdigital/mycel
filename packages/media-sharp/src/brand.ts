// Decode brand assets into a closed representation. SVG accepts a deliberately small drawing
// vocabulary and is rasterised before storage; WOFF2 is decompressed and bounded before storage.
// Rejected: passing arbitrary SVG to librsvg or trusting the four WOFF2 magic bytes.
import { brotliDecompressSync } from 'node:zlib';
import sharp from 'sharp';
import type { BrandProcessor } from '@mycel/core';

const bad = (reason: string): never => {
  throw new Error(`site.brand.${reason}`);
};
const tags = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
]);
const attrs = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
  'd',
  'x',
  'y',
  'x1',
  'x2',
  'y1',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'points',
  'transform',
]);
const safeValue = /^[#a-zA-Z0-9 .,%+()\-]*$/;
function safeSvg(bytes: Uint8Array): Uint8Array {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return bad('svg.unreadable');
  }
  if (/[&!]|<\?|url\s*\(|@|\\/i.test(source)) bad('svg.unsafe');
  let cursor = 0;
  let depth = 0;
  let root = false;
  const stack: string[] = [];
  const token = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*="[^"]*")*\s*\/?>/g;
  for (const match of source.matchAll(token)) {
    if (match.index !== cursor && source.slice(cursor, match.index).trim()) bad('svg.text');
    cursor = match.index! + match[0].length;
    const close = match[0].startsWith('</');
    const self = match[0].endsWith('/>');
    const name = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(match[0])?.[1] ?? '';
    if (!tags.has(name)) bad('svg.element');
    if (close) {
      if (--depth < 0 || stack.pop() !== name) bad('svg.structure');
      continue;
    }
    if (!root) {
      if (name !== 'svg') bad('svg.structure');
      root = true;
    }
    for (const attr of match[0].matchAll(/\s+([A-Za-z][A-Za-z0-9-]*)="([^"]*)"/g)) {
      if (!attrs.has(attr[1]!)) bad('svg.attribute');
      if (attr[1] === 'xmlns') {
        if (attr[2] !== 'http://www.w3.org/2000/svg') bad('svg.namespace');
      } else if (!safeValue.test(attr[2]!) || /(?:javascript|data|file|http)/i.test(attr[2]!))
        bad('svg.attribute');
    }
    if (!self) {
      depth++;
      stack.push(name);
    }
  }
  if (cursor !== source.length && source.slice(cursor).trim()) bad('svg.text');
  if (!root || depth !== 0) bad('svg.structure');
  return bytes;
}

function readBase128(data: Uint8Array, pos: number): [number, number] {
  let value = 0;
  for (let n = 0; n < 5; n++) {
    const byte = data[pos++];
    if (byte === undefined) return bad('font.directory');
    if ((n === 0 && byte === 0x80) || value > 0x01ffffff) bad('font.directory');
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, pos];
  }
  return bad('font.directory');
}
export function validateWoff2(data: Uint8Array): void {
  if (data.length < 48 || data.length > 1024 * 1024) bad('font.size');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u16 = (at: number) => view.getUint16(at);
  const u32 = (at: number) => view.getUint32(at);
  if (
    u32(0) !== 0x774f4632 ||
    u32(8) !== data.length ||
    u16(12) < 1 ||
    u16(12) > 128 ||
    u16(14) !== 0 ||
    u32(16) > 16 * 1024 * 1024
  )
    bad('font.header');
  const compressed = u32(20);
  let pos = 48;
  let expected = 0;
  for (let i = 0; i < u16(12); i++) {
    const flags = data[pos++];
    if (flags === undefined) return bad('font.directory');
    // Indices 0-62 name the known tables of the WOFF2 spec, so every one of them is valid; 63
    // means an arbitrary tag follows, which must be four characters in the OpenType tag range.
    const tag = flags & 63;
    if (tag === 63) {
      for (let k = 0; k < 4; k++) {
        const c = data[pos + k];
        if (c === undefined || c < 0x20 || c > 0x7e) bad('font.directory');
      }
      pos += 4;
    }
    let length: number;
    [length, pos] = readBase128(data, pos);
    let transformed = length;
    const transform = flags >> 6;
    if (tag === 10 || tag === 11 ? transform !== 3 : transform !== 0) {
      [transformed, pos] = readBase128(data, pos);
    }
    expected += transformed;
    if (expected > 16 * 1024 * 1024 || pos > data.length) bad('font.directory');
  }
  if (compressed < 1 || pos + compressed > data.length) bad('font.compressed');
  const metadataOffset = u32(28);
  const metadataLength = u32(32);
  const privateOffset = u32(40);
  const privateLength = u32(44);
  if (
    (metadataOffset === 0) !== (metadataLength === 0) ||
    (privateOffset === 0) !== (privateLength === 0) ||
    (metadataOffset && metadataOffset < pos + compressed) ||
    (privateOffset && privateOffset < pos + compressed) ||
    metadataOffset + metadataLength > data.length ||
    privateOffset + privateLength > data.length
  )
    bad('font.offset');
  try {
    const decoded = brotliDecompressSync(data.subarray(pos, pos + compressed), {
      maxOutputLength: 16 * 1024 * 1024,
    });
    if (decoded.length !== expected) bad('font.tables');
  } catch {
    bad('font.compressed');
  }
}

export function createBrandProcessor(): BrandProcessor {
  return {
    async logo(bytes, contentType) {
      if (bytes.length > 2 * 1024 * 1024) bad('logo.size');
      const svg = contentType === 'image/svg+xml';
      if (
        !svg &&
        !['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'].includes(contentType)
      )
        bad('logo.type');
      const source = svg ? safeSvg(bytes) : bytes;
      let meta;
      try {
        meta = await sharp(source, { limitInputPixels: 50_000_000 }).metadata();
      } catch {
        return bad('logo.unreadable');
      }
      const expected = contentType === 'image/avif' ? 'heif' : contentType.slice(6);
      if (!svg && meta.format !== expected) bad('logo.mismatch');
      if (!meta.width || !meta.height || meta.width * meta.height > 50_000_000) bad('logo.pixels');
      try {
        const result = await sharp(source, { limitInputPixels: 50_000_000 })
          .autoOrient()
          .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer({ resolveWithObject: true });
        return {
          bytes: result.data,
          contentType: 'image/webp',
          width: result.info.width,
          height: result.info.height,
          licence: null,
        };
      } catch {
        return bad('logo.unreadable');
      }
    },
    async font(bytes) {
      validateWoff2(bytes);
    },
  };
}
