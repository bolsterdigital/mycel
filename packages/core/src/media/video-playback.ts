// Playback reads the current published placement on every grant. A video record or a provider
// binding alone can never open delivery. Drafts, teasers and zones cannot mint a grant.
import { chapterList, transcriptCues, transcriptText } from './transcript.js';
import { z } from 'zod';
import { allBlocks, BlockId } from '../content/blocks.js';
import { ContentType, Slug } from '../content/model.js';
import { getPublished } from '../content/public.js';
import { entitled } from '../entitlements/guards.js';
import { UseCaseError } from '../errors.js';
import { Locale, pickAny } from '../i18n/locale.js';
import { getIntegrationPlacement } from '../integrations/service.js';
import type { TransactionContext } from '../ports.js';
import type { VideoRecord } from './video-model.js';

export const VideoPlacement = z
  .object({
    locale: Locale,
    type: ContentType,
    slug: Slug,
    block: BlockId,
  })
  .strict();
export type VideoPlacement = z.infer<typeof VideoPlacement>;

export async function videoPresentation(ctx: TransactionContext, id: string, locale?: string) {
  const video = await ctx.videos.get(id);
  if (!video || video.trashedAt) return null;
  const upload = await ctx.videos.upload(id);
  const playable =
    !!ctx.videoProvider &&
    upload?.libraryId === ctx.videoProvider.libraryId &&
    upload.state === 'ready' &&
    !!upload.providerId &&
    !!upload.mp4Height &&
    video.hasSource;
  const track = playable && locale ? (video.publishedTracks[locale] ?? '') : '';
  const chapters = playable && locale ? (video.publishedChapters?.[locale] ?? '') : '';
  return {
    // The lines with their times for the page, and the readable text search has always indexed.
    transcript: transcriptCues(track),
    transcriptText: transcriptText(track),
    // Chapters (MY-305) only beside a playable recording: they seek in it.
    chapters: chapterList(chapters),
    metadata: video.metadata,
    duration: video.durationSeconds,
    posterId: video.posterId,
    playable,
    // The one origin a page with this recording may fetch media from once its play is pressed
    // (the page's CSP, MY-305): the binding's CDN, never a value the tenant typed.
    origin: playable ? ctx.videoProvider!.playbackOrigin : null,
  };
}

async function placedRecording(ctx: TransactionContext, target: VideoPlacement) {
  if (!entitled(ctx.principal, 'blocks.video')) return null;
  const { embeds } = await getIntegrationPlacement.handler(ctx, {});
  if (!embeds.includes('bunny-stream')) return null;
  try {
    const item = await getPublished.handler(ctx, target);
    if (item.access !== 'public' || item.gate !== null) return null;
    const block = allBlocks(item.blocks).find((candidate) => candidate.id === target.block);
    if (block?.type !== 'video') return null;
    const video = await ctx.videos.get(block.props.videoId);
    const upload = await ctx.videos.upload(block.props.videoId);
    const provider = ctx.videoProvider;
    if (
      !video ||
      video.trashedAt ||
      !video.hasSource ||
      upload?.state !== 'ready' ||
      !provider ||
      provider.libraryId !== upload.libraryId ||
      !upload.providerId ||
      !upload.mp4Height
    )
      return null;
    return { video, item, provider, providerId: upload.providerId, mp4Height: upload.mp4Height };
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') return null;
    throw e;
  }
}

/** A signed text track of a placement: the captions, or the chapters (MY-305). */
export const TrackKind = z.enum(['captions', 'chapters']);
export type TrackKind = z.infer<typeof TrackKind>;

const trackToken = (
  tenant: string,
  video: string,
  revision: string,
  block: string,
  locale: string,
  kind: TrackKind,
  exp: number,
  version: string
) => `video-track:${tenant}:${video}:${revision}:${block}:${locale}:${kind}:${exp}:${version}`;

/** The published track of one kind in the placement's locale, or null without one. */
const publishedTrack = (video: VideoRecord, locale: string, kind: TrackKind) =>
  (kind === 'captions' ? video.publishedTracks[locale] : video.publishedChapters?.[locale]) || null;

export async function grantVideo(ctx: TransactionContext, target: VideoPlacement) {
  const placement = await placedRecording(ctx, target);
  if (!placement) return null;
  const { provider, providerId, mp4Height, item, video } = placement;
  const issued = Math.floor(ctx.clock.now().getTime() / 1000);
  const expires = issued + 900;
  // Each track gets its own signature over its own text: a changed track fails the old link.
  const sign = async (kind: TrackKind) => {
    const text = publishedTrack(video, target.locale, kind);
    if (!text) return null;
    const token = trackToken(
      ctx.principal.tenantId,
      video.id,
      item.revisionId,
      target.block,
      target.locale,
      kind,
      expires,
      await ctx.inputHasher.hash(text)
    );
    return { expires, signature: await ctx.signer.sign(token) };
  };
  return {
    expires,
    issued,
    ...provider.signPlayback(providerId, mp4Height, new Date(expires * 1000)),
    title: pickAny(video.metadata.title, target.locale) ?? item.title,
    track: await sign('captions'),
    chapters: await sign('chapters'),
  };
}

export async function readVideoTrack(
  ctx: TransactionContext,
  target: VideoPlacement,
  exp: number,
  signature: string,
  kind: TrackKind = 'captions'
) {
  if (!Number.isSafeInteger(exp) || exp * 1000 <= ctx.clock.now().getTime()) return null;
  const placement = await placedRecording(ctx, target);
  const text = placement && publishedTrack(placement.video, target.locale, kind);
  if (!placement || !text) return null;
  const expected = trackToken(
    ctx.principal.tenantId,
    placement.video.id,
    placement.item.revisionId,
    target.block,
    target.locale,
    kind,
    exp,
    await ctx.inputHasher.hash(text)
  );
  return (await ctx.signer.verify(signature)) === expected ? text : null;
}
