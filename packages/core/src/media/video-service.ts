// Reserve quota and persist intent before contacting Bunny. The worker never repeats a
// potentially successful create; it looks up the deterministic intent marker on retry.
import { z } from 'zod';
import { withinLimit, active } from '../entitlements/guards.js';
import { UseCaseError, notFound } from '../errors.js';
import { jobKey } from '../jobs/types.js';
import type { TransactionContext, UnitOfWork } from '../ports.js';
import type { Principal } from '../principal.js';
import { defineUseCase } from '../registry.js';
import {
  VideoMetadata,
  VideoUploadState,
  videoSourceKey,
  type VideoRecord,
} from './video-model.js';
import type { VideoProvider, VideoProviderStatus } from './ports.js';

const Id = z.string().guid();
const Amount = z.number().int().positive();
const VideoView = z.object({
  id: Id,
  posterId: Id,
  metadata: VideoMetadata,
  durationSeconds: Amount.nullable(),
  state: VideoUploadState.or(z.literal('unbound')),
});
const Target = z.object({ id: Id }).strict();
const EXAMPLE = '44444444-4444-4444-8444-444444444444';

function view(video: VideoRecord, state: z.infer<typeof VideoView>['state']) {
  return {
    id: video.id,
    posterId: video.posterId,
    metadata: video.metadata,
    durationSeconds: video.durationSeconds,
    state,
  };
}

async function liveVideo(ctx: TransactionContext, id: string) {
  const video = await ctx.videos.get(id);
  if (!video || video.trashedAt) throw notFound('video', id);
  return video;
}

async function usage(ctx: TransactionContext, bytes: number, seconds: number, except?: string) {
  const reserved = await ctx.videos.usage(except);
  withinLimit(ctx, 'video.storage_max_bytes', reserved.storageBytes, bytes);
  withinLimit(ctx, 'video.stored_max_minutes', reserved.durationSeconds / 60, seconds / 60);
}

function sameLibrary(
  provider: VideoProvider | null,
  libraryId: string | undefined
): provider is VideoProvider {
  return !!provider && provider.libraryId === libraryId;
}

export const createVideo = defineUseCase({
  name: 'media.video.create',
  kind: 'command',
  description: 'Reserve space and prepare one resumable upload in this site’s video library.',
  requires: 'media:write',
  consumes: 'video.storage_max_bytes',
  input: VideoMetadata.extend({
    uploadKey: Id,
    posterId: Id,
    sizeBytes: Amount,
    durationSeconds: Amount.max(2_147_483_647),
  }),
  output: VideoView,
  examples: [
    {
      input: {
        uploadKey: EXAMPLE,
        posterId: EXAMPLE,
        sizeBytes: 12000,
        durationSeconds: 60,
        title: { en: 'A short recording' },
        maker: 'Mycel',
        licence: { code: 'own-work' },
        watchUrl: null,
      },
    },
  ],
  async handler(ctx, { uploadKey, posterId, sizeBytes, durationSeconds, ...metadata }) {
    const provider = ctx.videoProvider;
    if (!provider)
      throw new UseCaseError('conflict', 'video uploads are unavailable for this site');
    await ctx.media.lock();
    const previous = await ctx.videos.byUploadKey(uploadKey);
    if (previous) {
      if (!sameLibrary(provider, previous.libraryId)) throw notFound('video', previous.videoId);
      return view(await liveVideo(ctx, previous.videoId), previous.state);
    }
    await usage(ctx, sizeBytes, durationSeconds);
    const poster = await ctx.media.get(posterId);
    if (
      !poster ||
      poster.deletedAt ||
      poster.kind !== 'image' ||
      poster.state !== 'ready' ||
      poster.access !== 'public'
    )
      throw notFound('video poster', posterId);
    const id = ctx.ids.next();
    const now = ctx.clock.now();
    const video: VideoRecord = {
      id,
      posterId,
      metadata,
      durationSeconds: null,
      hasSource: false,
      publishedTracks: {},
      createdAt: now,
      trashedAt: null,
    };
    await ctx.videos.insert(video);
    await ctx.media.replaceUsages(`video:${id}`, [{ mediaId: posterId, blockId: 'poster' }]);
    await ctx.videos.saveUpload({
      videoId: id,
      uploadKey,
      libraryId: provider.libraryId,
      providerId: null,
      mp4Height: null,
      state: 'reserved',
      storageBytes: sizeBytes,
      durationSeconds,
    });
    await ctx.jobs.enqueue({
      type: 'video.create',
      key: jobKey('video.create', id),
      runAt: now,
      payload: { videoId: id },
    });
    return view(video, 'reserved');
  },
});

export async function runVideoCreate(uow: UnitOfWork, principal: Principal, id: string) {
  const attempt = await uow.run(principal, async (ctx) => {
    if (!active(principal)) throw new UseCaseError('suspended', 'video creation paused');
    await ctx.media.lock();
    const video = await ctx.videos.get(id);
    const upload = await ctx.videos.upload(id);
    const provider = ctx.videoProvider;
    if (!video || video.trashedAt || !upload || !sameLibrary(provider, upload.libraryId))
      return null;
    if (upload.state !== 'reserved' && upload.state !== 'creating') return null;
    const create = upload.state === 'reserved';
    if (create) await ctx.videos.saveUpload({ ...upload, state: 'creating' });
    return { provider, create };
  });
  if (!attempt) return;
  const providerId = attempt.create
    ? await attempt.provider.create(id)
    : await attempt.provider.find(id);
  if (!providerId) throw new Error('Unresolved video creation. Await provider reconciliation.');
  await uow.run(principal, async (ctx) => {
    await ctx.media.lock();
    const upload = await ctx.videos.upload(id);
    if (upload?.state === 'creating' && upload.libraryId === attempt.provider.libraryId)
      await ctx.videos.saveUpload({ ...upload, providerId, state: 'upload' });
  });
}

async function currentUpload(ctx: TransactionContext, id: string) {
  const video = await liveVideo(ctx, id);
  const upload = await ctx.videos.upload(id);
  const provider = ctx.videoProvider;
  if (!upload || !sameLibrary(provider, upload.libraryId)) throw notFound('video upload', id);
  return { video, upload, provider };
}

async function accountedState(ctx: TransactionContext, id: string, status: VideoProviderStatus) {
  try {
    await usage(ctx, status.storageBytes, status.durationSeconds, id);
    return 'ready' as const;
  } catch (err) {
    if (!(err instanceof UseCaseError) || err.code !== 'limit_exceeded') throw err;
    return 'over-limit' as const;
  }
}

export const checkVideo = defineUseCase({
  name: 'media.video.check',
  kind: 'command',
  description: 'Check provider processing, outputs and quota for a video in this site.',
  requires: 'media:write',
  input: Target,
  output: VideoView,
  examples: [{ input: { id: EXAMPLE } }],
  async handler(ctx, { id }) {
    await ctx.media.lock();
    const { video, upload, provider } = await currentUpload(ctx, id);
    if (!upload.providerId) return view(video, upload.state);
    const status = await provider.status(upload.providerId, ctx.clock.now());
    if (status.state === 'upload' || status.state === 'encoding') {
      await ctx.videos.saveUpload({ ...upload, state: status.state });
      return view(video, status.state);
    }
    const state = status.state === 'failed' ? 'failed' : await accountedState(ctx, id, status);
    let hasSource = video.hasSource;
    if (status.state === 'complete' && !hasSource) {
      await provider.retainSource(
        upload.providerId,
        videoSourceKey(ctx.principal.tenantId, id),
        ctx.blobs,
        ctx.clock.now()
      );
      hasSource = true;
    }
    const durationSeconds = status.durationSeconds || video.durationSeconds;
    await ctx.videos.update(id, { hasSource, durationSeconds });
    await ctx.videos.saveUpload({
      ...upload,
      state,
      storageBytes: status.storageBytes,
      durationSeconds: status.durationSeconds,
      mp4Height: status.mp4Height,
    });
    return view({ ...video, durationSeconds, hasSource }, state);
  },
});

export const resumeVideo = defineUseCase({
  name: 'media.video.resume',
  kind: 'command',
  description: 'Get a short-lived upload grant for this site’s pending video.',
  requires: 'media:write',
  input: Target,
  output: z.object({ libraryId: z.string(), videoId: Id, signature: z.string(), expires: Amount }),
  examples: [{ input: { id: EXAMPLE } }],
  async handler(ctx, { id }) {
    await ctx.media.lock();
    const { upload, provider } = await currentUpload(ctx, id);
    if (upload.state !== 'upload' || !upload.providerId)
      throw new UseCaseError('conflict', 'this upload cannot be resumed');
    const now = ctx.clock.now();
    const status = await provider.status(upload.providerId, now);
    if (status.state !== 'upload')
      throw new UseCaseError('conflict', 'upload has already finished');
    await usage(ctx, upload.storageBytes, upload.durationSeconds, id);
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    return {
      libraryId: provider.libraryId,
      videoId: upload.providerId,
      ...provider.signUpload(upload.providerId, expiresAt),
    };
  },
});

export const listVideos = defineUseCase({
  name: 'media.video.list',
  kind: 'query',
  description: 'List the videos and upload states in this site’s media library.',
  requires: 'media:read',
  input: z.object({}).strict(),
  output: z.array(VideoView),
  examples: [{ input: {} }],
  async handler(ctx) {
    return Promise.all(
      (await ctx.videos.list()).map(async (video) => {
        const upload = await ctx.videos.upload(video.id);
        return view(
          video,
          sameLibrary(ctx.videoProvider, upload?.libraryId) ? upload!.state : 'unbound'
        );
      })
    );
  },
});

export const deleteVideo = defineUseCase({
  name: 'media.video.delete',
  kind: 'command',
  description: 'Trash an unused video record and retire its local grants.',
  requires: 'media:write',
  input: Target,
  output: z.object({ id: Id }),
  examples: [{ input: { id: EXAMPLE } }],
  async handler(ctx, { id }) {
    await ctx.media.lock();
    await liveVideo(ctx, id);
    if (await ctx.videos.used(id))
      throw new UseCaseError('conflict', 'the video is still referenced');
    await ctx.videos.update(id, { trashedAt: ctx.clock.now() });
    return { id };
  },
});
