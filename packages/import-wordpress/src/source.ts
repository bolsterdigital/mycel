// Where the importer gets the bytes of an attachment (brief wordpress-import-execution, PR 2): from
// a local copy of `wp-content/uploads` when one is given, else by downloading it from the old site.
// A download is `https` only, only from the host of the export's own site (`wp:base_blog_url`),
// never follows a redirect and stops at the upload limit of `media.upload`, so an export cannot
// make the importer fetch from elsewhere or fill the disk. The content type comes from the file
// name; `media.upload` checks it against the bytes. Rejected: trusting the server's Content-Type
// (a WordPress host often says `application/octet-stream`) and following redirects (a CDN move
// would be convenient, but the host check would then mean nothing).

import { readFile, stat } from 'node:fs/promises';
import { basename, join, normalize, resolve, sep } from 'node:path';
import { MAX_UPLOAD_BYTES, errorMessage } from '@mycel/core';
import type { MediaFile } from './execute.js';
import type { PlannedMedia } from './plan.js';

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
};

export const contentTypeOf = (filename: string) =>
  TYPES[filename.split('.').pop()?.toLowerCase() ?? ''] ?? null;

export interface MediaSourceOptions {
  /** The export's site address; downloads come only from its host. */
  siteUrl: string;
  /** A local copy of `wp-content/uploads`. */
  mediaDir?: string;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
}

/**
 * The path of an upload below `wp-content/uploads/`, kept inside the directory. `dir` is already
 * resolved, so `uploads/` and `uploads` give the same prefix.
 */
function localPath(dir: string, url: string): string[] {
  let path = '';
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return [];
  }
  const below = path.split('/wp-content/uploads/')[1];
  const candidates = below ? [normalize(join(dir, below))] : [];
  candidates.push(join(dir, basename(path)));
  return candidates.filter((c) => c.startsWith(dir + sep));
}

async function readBounded(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > max) return null;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function mediaSource(
  options: MediaSourceOptions
): (media: PlannedMedia) => Promise<MediaFile> {
  const max = options.maxBytes ?? MAX_UPLOAD_BYTES;
  const fetch = options.fetch ?? globalThis.fetch;
  const mediaDir = options.mediaDir ? resolve(options.mediaDir) : undefined;
  let siteHost: string | null = null;
  try {
    siteHost = new URL(options.siteUrl).host;
  } catch {
    siteHost = null;
  }
  return async (media) => {
    const contentType = contentTypeOf(media.filename);
    if (!contentType) return { error: `type not accepted: ${media.filename}` };
    if (mediaDir) {
      for (const path of localPath(mediaDir, media.url)) {
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) continue;
        if (info.size > max) return { error: `larger than ${max} bytes` };
        return { bytes: await readFile(path), contentType };
      }
      return { error: `not in the media directory: ${media.filename}` };
    }
    let url: URL;
    try {
      url = new URL(media.url);
    } catch {
      return { error: `not an address: ${media.url}` };
    }
    if (url.protocol !== 'https:') return { error: `not https: ${media.url}` };
    if (url.host !== siteHost) return { error: `not on the site's host: ${url.host}` };
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) return { error: `HTTP ${response.status}` };
      const bytes = await readBounded(response, max);
      return bytes ? { bytes, contentType } : { error: `larger than ${max} bytes` };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  };
}
