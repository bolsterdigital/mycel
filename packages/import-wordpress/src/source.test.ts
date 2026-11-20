// Where attachment bytes may come from: a local uploads copy that the path cannot leave, or an
// https download from the export's own host that follows no redirect and stops at the limit.

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mediaSource } from './source.js';
import type { PlannedMedia } from './plan.js';

const media = (url: string): PlannedMedia => ({
  ref: 'r',
  sourceId: 1,
  url,
  filename: url.split('/').pop()!,
  title: 't',
  alt: null,
});
const SITE = 'https://voorbeeld.example';

describe('mediaSource', () => {
  it('downloads only over https from the site host, without following redirects', async () => {
    const asked: { url: string; redirect: RequestInit['redirect'] }[] = [];
    const fetch = (async (url: URL, init?: RequestInit) => {
      asked.push({ url: String(url), redirect: init?.redirect });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]));
    }) as typeof globalThis.fetch;
    const get = mediaSource({ siteUrl: SITE, fetch });

    expect(await get(media(`${SITE}/wp-content/uploads/a.jpg`))).toMatchObject({
      contentType: 'image/jpeg',
    });
    expect(asked).toEqual([{ url: `${SITE}/wp-content/uploads/a.jpg`, redirect: 'error' }]);
    expect(await get(media('http://voorbeeld.example/wp-content/uploads/a.jpg'))).toEqual({
      error: expect.stringContaining('not https'),
    });
    expect(await get(media('https://elders.example/a.jpg'))).toEqual({
      error: expect.stringContaining("not on the site's host"),
    });
    expect(await get(media(`${SITE}/a.svg`))).toEqual({
      error: expect.stringContaining('type not accepted'),
    });
    expect(asked).toHaveLength(1);
  });

  it('stops a download at the upload limit, declared or not', async () => {
    const big = new Uint8Array(20);
    const declared = mediaSource({
      siteUrl: SITE,
      maxBytes: 10,
      fetch: (async () =>
        new Response(big, { headers: { 'content-length': '20' } })) as typeof globalThis.fetch,
    });
    expect(await declared(media(`${SITE}/a.jpg`))).toEqual({ error: 'larger than 10 bytes' });
    const streamed = mediaSource({
      siteUrl: SITE,
      maxBytes: 10,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(big.slice(0, 8));
              c.enqueue(big.slice(8));
              c.close();
            },
          })
        )) as typeof globalThis.fetch,
    });
    expect(await streamed(media(`${SITE}/a.jpg`))).toEqual({ error: 'larger than 10 bytes' });
  });

  it('reads a local uploads copy by its year and month path, never outside the directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-media-'));
    mkdirSync(join(dir, '2025', '03'), { recursive: true });
    writeFileSync(join(dir, '2025', '03', 'bos.jpg'), new Uint8Array([0xff, 0xd8, 0xff]));
    writeFileSync(join(tmpdir(), 'geheim.pdf'), '%PDF-');
    const get = mediaSource({ siteUrl: SITE, mediaDir: dir });

    expect(await get(media(`${SITE}/wp-content/uploads/2025/03/bos.jpg`))).toMatchObject({
      contentType: 'image/jpeg',
    });
    const escape = await get(media(`${SITE}/wp-content/uploads/..%2F..%2Fgeheim.pdf`));
    expect(escape).toEqual({ error: expect.stringContaining('not in the media directory') });
  });
});
