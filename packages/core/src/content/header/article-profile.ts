// Article profiles are revision data. Resolve defaults after access projection so the estimate
// counts only the words this reader sees, and old editions retain their original header.
import { z } from 'zod';
import { allBlocks } from '../blocks.js';
import type { ContentDocument } from '../model.js';

export const ARTICLE_PROFILES = ['post', 'longread'] as const;
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
      .object({ post: overrides.optional(), longread: overrides.optional() })
      .strict()
      .optional(),
  })
  .strict();

export const ArticleView = z.object({
  header: z.enum(ARTICLE_OPTIONS.header),
  portraits: z.boolean(),
  minutes: z.number().int().positive().nullable(),
  initial: z.boolean(),
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

export function articleView(
  doc: Extract<ContentDocument, { type: 'article' }>,
  locale: string
): ArticleView | undefined {
  const profile = doc.presentation?.profile;
  if (!profile) return undefined;
  const options = doc.presentation?.overrides?.[profile];
  const long = profile === 'longread';
  let minutes = null;
  if (!options?.readingTime) {
    const texts = [doc.lead?.[locale] ?? ''];
    for (const block of allBlocks(doc.blocks)) {
      if (block.type === 'heading' || block.type === 'quote')
        texts.push(block.props.text[locale] ?? '');
      if (block.type === 'rich-text') {
        const body = block.props.content[locale];
        if (body) texts.push(wordsOf(body));
      }
    }
    const words = texts.join(' ').match(/[\p{L}\p{N}]+(?:['’‐-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    if (words) minutes = Math.ceil(words / 200);
  }
  return {
    header: options?.header ?? (long ? 'cover' : 'standard'),
    portraits: options?.authors ? options.authors === 'portraits' : long,
    minutes,
    initial: long && !options?.initial,
  };
}
