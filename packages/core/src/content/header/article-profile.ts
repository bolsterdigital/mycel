// Article profiles are revision data. Resolve defaults after access projection so the estimate
// counts only the words this reader sees, and old editions retain their original header. The
// media profile (ADR 025, amended 2026-11-27) names the first `video` block the reader is served
// as the recording on top; the renderer lifts that block into the header. Rejected: a header
// field of its own for the recording, which needs a schema change and a second playback grant.
import { z } from 'zod';
import { allBlocks, type Block } from '../blocks.js';
import type { ContentDocument } from '../model.js';

export const ARTICLE_PROFILES = ['post', 'longread', 'media'] as const;
export const ARTICLE_HEADERS = ['standard', 'cover'] as const;
export const ARTICLE_OPTIONS = {
  header: ARTICLE_HEADERS,
  authors: ['names', 'portraits'],
  readingTime: ['hide'],
  initial: ['plain'],
} as const;
const overrides = z
  .object({
    header: z.enum(ARTICLE_OPTIONS.header).optional(),
    authors: z.enum(ARTICLE_OPTIONS.authors).optional(),
    readingTime: z.literal('hide').optional(),
    initial: z.literal('plain').optional(),
  })
  .strict();

export const ArticlePresentation = z
  .object({
    header: z.enum(ARTICLE_OPTIONS.header).optional(),
    profile: z.enum(ARTICLE_PROFILES).optional(),
    overrides: z
      .object({
        post: overrides.optional(),
        longread: overrides.optional(),
        media: overrides.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ArticleView = z.object({
  header: z.enum(ARTICLE_OPTIONS.header),
  portraits: z.boolean(),
  minutes: z.number().int().positive().nullable(),
  initial: z.boolean(),
  /**
   * The media profile's recording on top: the first `video` block in the served projection, and
   * whether the meta line shows its duration (the profile's `readingTime` override hides it).
   * Absent on every other profile and on a media article without a recording, which reads as Post.
   */
  video: z.object({ blockId: z.string(), duration: z.boolean() }).strict().optional(),
});
export type ArticleView = z.infer<typeof ArticleView>;

type TextNode = { type: string; text?: string; content?: readonly TextNode[] | undefined };
function wordsOf(node: TextNode): string {
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hard_break') return ' ';
  return (node.content ?? [])
    .map(wordsOf)
    .join(['paragraph', 'heading'].includes(node.type) ? '' : ' ');
}

/**
 * The media profile's recording: the first `video` block of `doc` as given (so a card's teaser
 * projection, which has no blocks, has none), and whether its duration may show.
 */
export function mediaRecording(doc: ContentDocument) {
  if (doc.type !== 'article' || doc.presentation?.profile !== 'media') return undefined;
  const block = allBlocks(doc.blocks).find(
    (b): b is Extract<Block, { type: 'video' }> => b.type === 'video'
  );
  return block && { ...block, duration: !doc.presentation.overrides?.media?.readingTime };
}

export function articleView(
  doc: Extract<ContentDocument, { type: 'article' }>,
  locale: string
): ArticleView | undefined {
  const profile = doc.presentation?.profile;
  if (!profile) return undefined;
  const options = doc.presentation?.overrides?.[profile];
  const long = profile === 'longread';
  const recording = mediaRecording(doc);
  let minutes = null;
  if (!options?.readingTime) {
    const texts = [doc.lead?.[locale] ?? ''];
    for (const block of allBlocks(doc.blocks)) {
      if (block.type === 'heading' || block.type === 'quote')
        texts.push(block.props.text[locale] ?? '');
      if (block.type === 'callout') {
        const body = block.props.body[locale];
        if (body) texts.push(block.props.title?.[locale] ?? '', wordsOf(body));
      }
      if (block.type === 'rich-text') {
        const body = block.props.content[locale];
        if (body) texts.push(wordsOf(body));
      }
    }
    const words = texts.join(' ').match(/[\p{L}\p{N}]+(?:['’‐-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    if (words) minutes = Math.ceil(words / 200);
  }
  return {
    // The recording is the header's image, so a media header is never a cover.
    header: recording ? 'standard' : (options?.header ?? (long ? 'cover' : 'standard')),
    portraits: options?.authors ? options.authors === 'portraits' : long,
    minutes,
    initial: long && !options?.initial,
    ...(recording ? { video: { blockId: recording.id, duration: recording.duration } } : {}),
  };
}
