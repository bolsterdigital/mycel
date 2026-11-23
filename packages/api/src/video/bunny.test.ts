import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { bunnyLibraries, bunnyVideo } from './bunny.js';

const id = 'f7f0cef5-0500-4ac4-a43c-63108f5d4b18';
const binding = {
  tenantId: '039d7e18-89ae-4597-ab00-aeec8519cda6',
  libraryId: '123',
  apiKey: 'fixture-upload-secret',
  cdnKey: 'fixture-cdn-secret',
  cdnHost: 'video-fixture.b-cdn.net',
  storageHost: 'storage.bunnycdn.com' as const,
  storageZone: 'fixture-zone',
  storageReadKey: 'fixture-storage-secret',
};
const at = new Date('2026-11-23T12:00:00Z');
const fixture = async () =>
  JSON.parse(
    await readFile(new URL('../../fixtures/bunny/video-ready.json', import.meta.url), 'utf8')
  );

describe('Bunny Stream', () => {
  it('accepts a single dedicated binding and keeps upload and delivery credentials out of URLs', () => {
    const provider = bunnyLibraries(JSON.stringify([binding]))(binding.tenantId)!;
    const grant = provider.signUpload(id, at);
    const expected = createHash('sha256')
      .update(`123${binding.apiKey}${grant.expires}${id}`)
      .digest('hex');
    expect(grant.signature).toEqual(expected);
    const { hls, mp4 } = provider.signPlayback(id, 360, at);
    expect(hls).toMatch(
      new RegExp(
        `^https://video-fixture\\.b-cdn\\.net/bcdn_token=HS256-[A-Za-z0-9_-]+&expires=\\d+&token_path=%2F${id}%2F/${id}/playlist\\.m3u8$`
      )
    );
    expect(mp4).toContain(`/${id}/play_360p.mp4`);
    expect(hls).not.toContain(binding.cdnKey);
    expect(() => bunnyLibraries(JSON.stringify([binding, { ...binding, tenantId: id }]))).toThrow(
      'dedicated library'
    );
  });

  it('requires a protected playlist and checks encoded fallback files with scoped URLs', async () => {
    const body = await fixture();
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://video.bunnycdn.com')) return Response.json(body);
      if (!url.includes('bcdn_token=')) return new Response(null, { status: 403 });
      if (url.endsWith('play_480p.mp4')) return new Response(null, { status: 404 });
      return new Response(null, { status: 200 });
    });
    const provider = bunnyVideo(binding, request);
    expect(await provider.status(id, at)).toEqual({
      state: 'complete',
      durationSeconds: 54,
      storageBytes: 52053630,
      mp4Height: 360,
    });
    body.videoLibraryId = 124;
    await expect(provider.status(id, at)).rejects.toThrow('outside the requested binding');
    body.videoLibraryId = 123;
    request
      .mockResolvedValueOnce(Response.json(body))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(provider.status(id, at)).rejects.toThrow('require a token');
  });
});
