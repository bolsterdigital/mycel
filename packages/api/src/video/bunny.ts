// Bunny's API returns identifiers and state. Every file URL is derived locally from the
// configured library and a verified identifier. Keeping storage credentials off the CDN makes
// the retained original available to export without granting it to the browser.
import { createHash, createHmac } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { VideoProvider, VideoProviderStatus } from '@mycel/core';

const Guid = z.uuid();
const Binding = z
  .object({
    tenantId: Guid,
    libraryId: z.string().regex(/^\d+$/),
    apiKey: z.string().min(1),
    cdnKey: z.string().min(1),
    cdnHost: z.string().regex(/^[a-z0-9-]+\.b-cdn\.net$/),
    storageHost: z.enum([
      'storage.bunnycdn.com',
      'uk.storage.bunnycdn.com',
      'se.storage.bunnycdn.com',
    ]),
    storageZone: z.string().regex(/^[a-z0-9-]+$/),
    storageReadKey: z.string().min(1),
  })
  .strict();
type Binding = z.infer<typeof Binding>;

const VideoId = z.object({
  guid: Guid,
  videoLibraryId: z.number().int().positive(),
  title: z.string(),
});
const VideoStatus = VideoId.extend({
  status: z.number().int(),
  length: z.number().int().nonnegative(),
  storageSize: z.number().int().nonnegative(),
  availableResolutions: z.string().nullish(),
});

export function bunnyLibraries(config: string | undefined) {
  if (!config) return () => null;
  let bindings: Binding[];
  try {
    bindings = z.array(Binding).parse(JSON.parse(config));
    for (const key of ['tenantId', 'libraryId', 'cdnHost', 'storageZone'] as const) {
      if (new Set(bindings.map((binding) => binding[key])).size !== bindings.length)
        throw new Error();
    }
  } catch {
    throw new Error('BUNNY_VIDEO_LIBRARIES must define a dedicated library and CDN per tenant');
  }
  const providers = new Map(bindings.map((binding) => [binding.tenantId, bunnyVideo(binding)]));
  return (tenantId: string) => providers.get(tenantId) ?? null;
}

export function bunnyVideo(binding: Binding, request = fetch): VideoProvider {
  const { libraryId, apiKey, cdnHost, cdnKey, storageHost, storageZone, storageReadKey } = binding;
  const videos = `https://video.bunnycdn.com/library/${libraryId}/videos`;
  const cdn = `https://${cdnHost}`;
  const marker = (id: string) => `mycel:${Guid.parse(id)}`;

  async function api(path: string, title?: string) {
    const response = await request(videos + path, {
      ...(title ? { method: 'POST', body: JSON.stringify({ title }) } : {}),
      headers: { AccessKey: apiKey, 'Content-Type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Bunny video API returned ${response.status}`);
    return response.json();
  }

  function bound(row: z.infer<typeof VideoId>, expected?: string) {
    if (String(row.videoLibraryId) !== libraryId || (expected && row.guid !== expected))
      throw new Error('Bunny returned a video outside the requested binding');
    return row;
  }

  function signedDirectory(id: string, expires: number) {
    const path = `/${Guid.parse(id)}/`;
    const token = createHmac('sha256', cdnKey)
      .update(`${path}${expires}token_path=${path}`)
      .digest('base64url');
    return `${cdn}/bcdn_token=HS256-${token}&expires=${expires}&token_path=${encodeURIComponent(path)}${path}`;
  }

  function playback(id: string, height: number, expiresAt: Date) {
    const base = signedDirectory(id, Math.floor(expiresAt.getTime() / 1000));
    return { hls: `${base}playlist.m3u8`, mp4: `${base}play_${height}p.mp4` };
  }

  return {
    libraryId,
    playbackOrigin: cdn,
    async create(id) {
      return bound(VideoId.parse(await api('', marker(id)))).guid;
    },
    async find(id) {
      const title = marker(id);
      const query = new URLSearchParams({ search: title, itemsPerPage: '100' });
      const rows = z.object({ items: z.array(VideoId) }).parse(await api(`?${query}`)).items;
      const matching = rows.filter((row) => row.title === title);
      if (matching.length > 1)
        throw new Error('Bunny returned multiple videos for the upload intent');
      return matching[0] ? bound(matching[0]).guid : null;
    },
    async status(id, now): Promise<VideoProviderStatus> {
      const row = VideoStatus.parse(await api(`/${Guid.parse(id)}`));
      bound(row, id);
      const amounts = {
        durationSeconds: row.length,
        storageBytes: row.storageSize,
        mp4Height: null,
      };
      if (row.status === 0 || row.status === 7) return { ...amounts, state: 'upload' };
      if (row.status === 5 || row.status === 6) return { ...amounts, state: 'failed' };
      if (row.status !== 4 || !row.length || !row.storageSize)
        return { ...amounts, state: 'encoding' };
      const ends = new Date(now.getTime() + 60000);
      const heights = (row.availableResolutions ?? '')
        .split(',')
        .map((size) => /^([1-9]\d{2,3})p$/.exec(size)?.[1])
        .filter((height): height is string => !!height)
        .map(Number)
        .sort((a, b) => b - a);
      const options = {
        method: 'HEAD',
        redirect: 'error' as const,
        signal: AbortSignal.timeout(10000),
      };
      const unsigned = await request(`${cdn}/${id}/playlist.m3u8`, options);
      if (unsigned.status !== 403)
        throw new Error('Bunny CDN must require a token for direct delivery');
      const hls = await request(playback(id, 0, ends).hls, options);
      if (!hls.ok) return { ...amounts, state: 'encoding' };
      for (const height of heights) {
        const mp4 = await request(playback(id, height, ends).mp4, options);
        if (mp4.ok) return { ...amounts, state: 'complete', mp4Height: height };
      }
      return { ...amounts, state: 'encoding' };
    },
    async retainSource(id, key, blobs) {
      const url = `https://${storageHost}/${storageZone}/${Guid.parse(id)}/original`;
      const response = await request(url, {
        headers: { AccessKey: storageReadKey },
        redirect: 'error',
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok || !response.body) throw new Error('Bunny retained original is unavailable');
      const dir = await mkdtemp(join(tmpdir(), 'mycel-video-'));
      const file = join(dir, 'original');
      try {
        await pipeline(response.body, createWriteStream(file));
        await blobs.putFile(key, file, { contentType: 'application/octet-stream' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    signUpload(id, expiresAt) {
      const expires = Math.floor(expiresAt.getTime() / 1000);
      const signature = createHash('sha256')
        .update(`${libraryId}${apiKey}${expires}${Guid.parse(id)}`)
        .digest('hex');
      return { signature, expires };
    },
    signPlayback: playback,
  };
}
