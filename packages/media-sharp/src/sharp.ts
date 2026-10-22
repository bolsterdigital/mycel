// `ImageProcessor` on sharp (libvips, Apache-2.0; TODO #10). `probe` reads the header only, so a
// decompression bomb is refused by the core's pixel limit before a pixel is decoded; `render`
// also refuses one itself (`limitInputPixels`), so this adapter is safe on its own. Every render
// applies the EXIF orientation and writes no metadata: sharp drops EXIF, XMP, IPTC and ICC
// unless asked to keep them, and nothing here asks. A GIF rendered to GIF keeps its frames; to
// any other format it is its first frame.
//
// Rejected: ImageMagick or a CLI (a process per image and a larger attack surface) and squoosh
// (unmaintained). sharp ships prebuilt binaries for linux-x64 and arm64 through optional
// dependencies, so `npm ci --ignore-scripts` (the Dockerfile) installs it without a compiler.

import sharp, { type Metadata, type Sharp } from 'sharp';
import { MAX_PIXELS, type ImageFormat, type ImageProcessor } from '@mycel/core';

export interface SharpProcessorOptions {
  /** Refuse to decode an image larger than this many pixels (default: the core's limit). */
  maxPixels?: number;
}

const QUALITY: Record<ImageFormat, (s: Sharp) => Sharp> = {
  avif: (s) => s.avif({ quality: 55, effort: 4 }),
  webp: (s) => s.webp({ quality: 80 }),
  jpeg: (s) => s.jpeg({ quality: 85, mozjpeg: true }),
  png: (s) => s.png({ compressionLevel: 9 }),
  gif: (s) => s.gif(),
};

export function createSharpProcessor({
  maxPixels = MAX_PIXELS,
}: SharpProcessorOptions = {}): ImageProcessor {
  return {
    async probe(bytes) {
      let m: Metadata;
      try {
        // Header only; `limitInputPixels: false` because the caller decides about the size.
        m = await sharp(bytes, { limitInputPixels: false }).metadata();
      } catch {
        return null;
      }
      const format: ImageFormat | null =
        m.format === 'jpeg' || m.format === 'png' || m.format === 'webp' || m.format === 'gif'
          ? m.format
          : m.format === 'heif' && m.compression === 'av1'
            ? 'avif'
            : null;
      // As a viewer sees it: after the EXIF orientation, one page of an animation.
      const width = m.autoOrient?.width ?? m.width;
      const height = m.autoOrient?.height ?? m.height;
      if (!format || !width || !height) return null;
      return { format, width, height };
    },

    async render(bytes, { width, format }) {
      const animated = format === 'gif';
      const pipeline = sharp(bytes, { limitInputPixels: maxPixels, animated })
        .autoOrient()
        .resize({ width, withoutEnlargement: true });
      const { data, info } = await QUALITY[format](pipeline).toBuffer({ resolveWithObject: true });
      return {
        bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.pageHeight ?? info.height,
      };
    },
  };
}
