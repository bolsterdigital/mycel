// The inheritance chain of an item's images and short texts (#86): what an editor left empty is
// filled from the next field along one fixed chain, and every value says where it came from, so
// the edit screen can show "Default: the hero image" and a card, the SEO head, the API and the
// MCP tools never derive it on their own.
//
//   hero      own heroImageId                      → nothing
//   featured  own featuredImageId → hero           → the site's default image
//   share     own seo.imageId → featured → hero    → the site's default image
//   featured title        own featured.title → title
//   summary               own featured.description → lead → first paragraph
//   SEO description       own seo.description → summary
//
// A derived text is the first paragraph of its source, whitespace folded and cut at a word to a
// sentence or two; an own value is returned as the editor wrote it. The functions are pure and
// read one locale; the site's default image is an argument because it is site data, not part of
// the revision (`site.image.*` stores it).
//
// Rejected: storing the derived values on the revision (they go stale the moment the lead
// changes, and a site default would have to be written into every item), and a separate card
// image per placement (one image per role; the renderer picks the variant).

import { z } from 'zod';
import { allBlocks } from '../blocks.js';
import type { RichTextDoc } from '../rich-text.js';
import type { ContentDocument } from '../model.js';

export type ImageSource = 'own' | 'featured' | 'hero' | 'site';
export type TextSource = 'seo' | 'featured' | 'lead' | 'first-paragraph';

/** An image of the item and where it came from; both null when the chain has nothing. */
export interface EffectiveImage {
  mediaId: string | null;
  source: ImageSource | null;
}

export interface EffectiveText {
  text: string | null;
  source: TextSource | null;
}

/** What the site adds to the chain: its default image (`SiteImages`). */
export interface ChainSite {
  defaultImageId?: string | null | undefined;
}

/** A derived description is a sentence or two; longer text is cut at a word. */
export const SUMMARY_MAX = 300;

type ImageFields = Pick<ContentDocument, 'heroImageId' | 'featuredImageId' | 'seo'>;
type TextFields = Pick<ContentDocument, 'title' | 'featured' | 'lead' | 'seo' | 'blocks'>;

const NONE: EffectiveImage = { mediaId: null, source: null };

/** The first link of the chain that has an image. */
function first(...links: [string | null | undefined, ImageSource][]): EffectiveImage {
  for (const [mediaId, source] of links) if (mediaId) return { mediaId, source };
  return NONE;
}

export function effectiveImages(
  doc: ImageFields,
  site: ChainSite = {}
): { hero: EffectiveImage; featured: EffectiveImage; share: EffectiveImage } {
  const site_ = site.defaultImageId;
  return {
    hero: first([doc.heroImageId, 'own']),
    featured: first([doc.featuredImageId, 'own'], [doc.heroImageId, 'hero'], [site_, 'site']),
    share: first(
      [doc.seo.imageId, 'own'],
      [doc.featuredImageId, 'featured'],
      [doc.heroImageId, 'hero'],
      [site_, 'site']
    ),
  };
}

/** The title where the item is featured elsewhere: its own, else the item's title. */
export function effectiveFeaturedTitle(
  doc: Pick<ContentDocument, 'title' | 'featured'>,
  locale: string
): { text: string; source: 'featured' | 'title' } {
  const own = doc.featured?.title?.[locale];
  return own
    ? { text: own, source: 'featured' }
    : { text: doc.title[locale] ?? '', source: 'title' };
}

/** The description where the item is featured elsewhere. */
export function effectiveSummary(doc: TextFields, locale: string): EffectiveText {
  const own = doc.featured?.description?.[locale];
  if (own) return { text: own, source: 'featured' };
  const lead = cut(doc.lead?.[locale]?.split(/\n\s*\n/)[0]);
  if (lead) return { text: lead, source: 'lead' };
  const paragraph = cut(firstParagraph(doc.blocks, locale));
  if (paragraph) return { text: paragraph, source: 'first-paragraph' };
  return { text: null, source: null };
}

/** The meta description for search engines and share previews. */
export function effectiveSeoDescription(doc: TextFields, locale: string): EffectiveText {
  const own = doc.seo.description?.[locale];
  return own ? { text: own, source: 'seo' } : effectiveSummary(doc, locale);
}

/** The whole chain for one locale, as the read routes and `content.item.get` return it. */
export function effectiveOf(doc: ImageFields & TextFields, locale: string, site: ChainSite = {}) {
  return {
    images: effectiveImages(doc, site),
    title: effectiveFeaturedTitle(doc, locale),
    summary: effectiveSummary(doc, locale),
    seoDescription: effectiveSeoDescription(doc, locale),
  };
}

const ImageView = z.object({
  mediaId: z.string().guid().nullable(),
  source: z.enum(['own', 'featured', 'hero', 'site']).nullable(),
});
const TextView = z.object({
  text: z.string().nullable(),
  source: z.enum(['seo', 'featured', 'lead', 'first-paragraph']).nullable(),
});
/** One locale of the chain in `effective.ts`, as the read routes and the MCP tools return it. */
export const EffectiveView = z.object({
  images: z.object({ hero: ImageView, featured: ImageView, share: ImageView }),
  title: z.object({ text: z.string(), source: z.enum(['featured', 'title']) }),
  summary: TextView,
  seoDescription: TextView,
});

type Node = { type: string; text?: string; content?: Node[] };
const plain = (n: Node): string =>
  n.type === 'hard_break' ? ' ' : (n.text ?? (n.content ?? []).map(plain).join(''));

/** The text of the first non-empty paragraph of the first rich-text block that has one. */
function firstParagraph(blocks: ContentDocument['blocks'], locale: string): string | null {
  for (const b of allBlocks(blocks)) {
    if (b.type !== 'rich-text') continue;
    const doc = (b.props as { content: Partial<Record<string, RichTextDoc>> }).content[locale];
    for (const node of (doc?.content ?? []) as Node[]) {
      if (node.type !== 'paragraph') continue;
      const text = plain(node).trim();
      if (text) return text;
    }
  }
  return null;
}

/** Whitespace folded and at most `SUMMARY_MAX` characters, cut at a word with an ellipsis. */
function cut(text: string | null | undefined): string | null {
  const flat = text?.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= SUMMARY_MAX) return flat;
  const head = flat.slice(0, SUMMARY_MAX - 1);
  const space = head.lastIndexOf(' ');
  return `${space > 0 ? head.slice(0, space) : head}…`;
}
