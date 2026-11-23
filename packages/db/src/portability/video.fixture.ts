import { expect } from 'vitest';
import type { ExportManifest } from './export.js';
import { videoSourceKey, type BlobStore, type Principal, type UnitOfWork } from '@mycel/core';
import { uuidv7 } from '../infra/ids.js';

export async function seedVideo(
  uow: UnitOfWork,
  principal: Principal,
  blobs: BlobStore,
  posterId: string
) {
  const id = uuidv7();
  await blobs.put(videoSourceKey(principal.tenantId, id), Uint8Array.of(1, 2, 3), {
    contentType: 'application/octet-stream',
  });
  await uow.run(principal, async ({ media, videos }) => {
    await videos.insert({
      id,
      posterId,
      durationSeconds: 10,
      hasSource: true,
      createdAt: new Date(),
      trashedAt: null,
      publishedTracks: { nl: 'WEBVTT\n\n00:00.000 --> 00:02.000\nLangs de rivier\n' },
      metadata: {
        title: { nl: 'Video export' },
        maker: 'Mycel',
        licence: { code: 'cc0' },
        watchUrl: null,
      },
    });
    await media.replaceUsages(`video:${id}`, [{ mediaId: posterId, blockId: 'poster' }]);
    await videos.saveUpload({
      videoId: id,
      uploadKey: uuidv7(),
      libraryId: '123456',
      providerId: uuidv7(),
      mp4Height: 360,
      storageBytes: 1000,
      durationSeconds: 10,
      state: 'ready',
    });
  });
}

export function expectVideoArchive(manifest: ExportManifest) {
  expect(manifest.tables).not.toHaveProperty('managed_video_uploads');
  expect(manifest.tables.managed_videos?.rows).toBe(1);
  expect(
    Object.keys(manifest.media).some((key) => key.endsWith('/original') && key.includes('/video/'))
  ).toBe(true);
}
