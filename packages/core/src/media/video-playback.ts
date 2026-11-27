// Playback reads the current published placement on every grant. A video record or a provider
// binding alone can never open delivery. Drafts, teasers and zones cannot mint a grant.
import { transcriptCues, transcriptText } from './transcript.js';
import { z } from 'zod';
import { allBlocks, BlockId } from '../content/blocks.js';
import { ContentType, Slug } from '../content/model.js';
import { getPublished } from '../content/public.js';
import { entitled } from '../entitlements/guards.js';
import { UseCaseError } from '../errors.js';
import { Locale, pickAny } from '../i18n/locale.js';
import { getIntegrationPlacement } from '../integrations/service.js';
import type { TransactionContext } from '../ports.js';

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
  return {
    // The lines with their times for the page, and the readable text search has always indexed.
    transcript: transcriptCues(track),
    transcriptText: transcriptText(track),
    metadata: video.metadata,
    duration: video.durationSeconds,
    posterId: video.posterId,
    playable,
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

const trackToken = (
  tenant: string,
  video: string,
  revision: string,
  block: string,
  locale: string,
  exp: number,
  version: string
) => `video-track:${tenant}:${video}:${revision}:${block}:${locale}:${exp}:${version}`;

export async function grantVideo(ctx: TransactionContext, target: VideoPlacement) {
  const placement = await placedRecording(ctx, target);
  if (!placement) return null;
  const { provider, providerId, mp4Height, item, video } = placement;
  const issued = Math.floor(ctx.clock.now().getTime() / 1000);
  const expires = issued + 900;
  const caption = video.publishedTracks[target.locale];
  const track = caption
    ? {
        expires,
        signature: await ctx.signer.sign(
          trackToken(
            ctx.principal.tenantId,
            video.id,
            item.revisionId,
            target.block,
            target.locale,
            expires,
            await ctx.inputHasher.hash(caption)
          )
        ),
      }
    : null;
  return {
    expires,
    issued,
    ...provider.signPlayback(providerId, mp4Height, new Date(expires * 1000)),
    title: pickAny(video.metadata.title, target.locale) ?? item.title,
    track,
  };
}

export async function readVideoTrack(
  ctx: TransactionContext,
  target: VideoPlacement,
  exp: number,
  signature: string
) {
  if (!Number.isSafeInteger(exp) || exp * 1000 <= ctx.clock.now().getTime()) return null;
  const placement = await placedRecording(ctx, target);
  if (!placement || !placement.video.publishedTracks[target.locale]) return null;
  const expected = trackToken(
    ctx.principal.tenantId,
    placement.video.id,
    placement.item.revisionId,
    target.block,
    target.locale,
    exp,
    await ctx.inputHasher.hash(placement.video.publishedTracks[target.locale]!)
  );
  return (await ctx.signer.verify(signature)) === expected
    ? placement.video.publishedTracks[target.locale]!
    : null;
}
