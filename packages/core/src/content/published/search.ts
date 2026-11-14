// Site search for visitors (TODO #42A): what a site publishes for everyone, found by words.
//
// One text rule, here, for every adapter. `searchTokens` folds text to tokens (NFKD, combining
// marks dropped, lower case, split on everything that is no letter or digit); a document gives a
// title set and a set over title, lead and every localised block field in one locale; a document
// matches when every token of the question is the start of one of its tokens. The memory adapter
// applies `matchesSearch` to the published revisions, Postgres stores the same tokens as config-free
// `tsvector`s and asks a prefix `tsquery`, so both give the same rows in the same order.
//
// Access is decided twice. `searchEntry` gives no entry for a revision that is restricted or
// `noindex`, so neither adapter can find one; the use case then reads each hit's published revision
// again and drops it unless it is public and indexable. Title, lead and excerpt come from that
// revision, never from an index: the index holds tokens, no readable text. Restricted items are
// left out whole, title included; reader results are #42B, after reader access (#19).
//
// Order: hits whose title carries every token first, then newest publication, then item id. A
// page is a number, capped at `MAX_SEARCH_PAGE`: a visitor reads the first pages, and a cursor
// over a rank that a publication can change buys nothing here.
//
// Rejected: a language configuration per locale with stemming (the memory adapter cannot
// reproduce a Snowball stemmer, so the conformance of the two would be a promise instead of a
// test, and a tenant locale without a configuration would silently search differently; prefixes
// already find `fietspad` for `fiets`), `ILIKE` over stored text (a second readable copy of every
// published body that erasure and unpublication would have to chase), and non-localised fields
// (credits, makers, URLs and ids are not what a visitor searches, and credits are what person
// erasure rewrites).

import { z } from 'zod';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { allBlocks, blockLocalized } from '../blocks.js';
import { ContentType, Slug, type ContentDocument } from '../model.js';
import type { PublishedHit } from '../ports.js';
import '../ports.js';

/** The longest question, in characters; a search box, not a document. */
export const MAX_SEARCH_QUERY = 200;
/** How many tokens of a question count; the rest is ignored. */
export const MAX_SEARCH_TOKENS = 8;
/** A token shorter than this matches nearly every document as a prefix, so it is ignored. */
export const MIN_SEARCH_TOKEN = 2;
/** The last page a visitor can ask for. */
export const MAX_SEARCH_PAGE = 20;
/** The longest token kept; longer runs of letters are cut, on both sides alike. */
const MAX_TOKEN_LENGTH = 64;
/** About how long an excerpt is, in characters. */
const EXCERPT_LENGTH = 180;

/** Text as search tokens, in order, duplicates included. */
export function searchTokens(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => t.slice(0, MAX_TOKEN_LENGTH));
}

/** The tokens a question searches for: distinct, long enough, at most `MAX_SEARCH_TOKENS`. */
export function queryTokens(q: string): string[] {
  const tokens = searchTokens(q).filter((t) => t.length >= MIN_SEARCH_TOKEN);
  return [...new Set(tokens)].slice(0, MAX_SEARCH_TOKENS);
}

type Node = { type?: string; text?: string; content?: Node[] };
const inline = (n: Node): string =>
  n.type === 'hard_break' ? ' ' : (n.text ?? (n.content ?? []).map(inline).join(''));

/** A localised value as plain text: a string, or rich text with a space between its blocks. */
function plainText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return ((value as Node).content ?? []).map(inline).join(' ');
}

/**
 * The texts a visitor can search in one locale of a document, in reading order: the title, then
 * the lead and every localised block field. Driven by `blockLocalized`, as projection and
 * readiness are, so a new block type is searchable without a line here.
 */
export function searchTexts(
  doc: Pick<ContentDocument, 'title' | 'lead' | 'blocks'>,
  locale: string
): { title: string; body: string[] } {
  const body: string[] = [];
  const add = (text: string) => {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat) body.push(flat);
  };
  add(doc.lead?.[locale] ?? '');
  for (const block of allBlocks(doc.blocks))
    for (const field of blockLocalized(block)) add(plainText(field.value[locale]));
  return { title: (doc.title[locale] ?? '').replace(/\s+/g, ' ').trim(), body };
}

/** The distinct tokens of one locale of a document: those of its title, and all of them. */
export interface SearchEntry {
  title: string[];
  all: string[];
}

/**
 * What the index holds for one locale of a revision; null when that revision is not for
 * everyone or asks not to be listed, so no adapter has anything to find it by.
 */
export function searchEntry(doc: ContentDocument, locale: string): SearchEntry | null {
  if (doc.access.level !== 'public' || doc.seo.noindex) return null;
  const texts = searchTexts(doc, locale);
  const title = [...new Set(searchTokens(texts.title))];
  return { title, all: [...new Set([...title, ...texts.body.flatMap(searchTokens)])] };
}

const carries = (have: readonly string[], tokens: readonly string[]) =>
  tokens.every((t) => have.some((h) => h.startsWith(t)));

/** Null: no match. Else whether the title alone carries every token, which ranks first. */
export function matchesSearch(
  entry: SearchEntry,
  tokens: readonly string[]
): { inTitle: boolean } | null {
  if (!tokens.length || !carries(entry.all, tokens)) return null;
  return { inTitle: carries(entry.title, tokens) };
}

/** The order of hits, which both adapters apply. */
export function compareHits(
  a: Pick<PublishedHit, 'inTitle' | 'publishedAt' | 'itemId'>,
  b: Pick<PublishedHit, 'inTitle' | 'publishedAt' | 'itemId'>
): number {
  if (a.inTitle !== b.inTitle) return a.inTitle ? -1 : 1;
  const time = b.publishedAt.getTime() - a.publishedAt.getTime();
  if (time) return time;
  return a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0;
}

export const SearchSegment = z.object({ text: z.string(), match: z.boolean() });
export type SearchSegment = z.infer<typeof SearchSegment>;

/** The words of a text with their place, and whether a token starts them. */
function words(text: string, tokens: readonly string[]) {
  const found: { start: number; end: number; match: boolean }[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
    const [folded = ''] = searchTokens(m[0]);
    found.push({
      start: m.index,
      end: m.index + m[0].length,
      match: tokens.some((t) => folded.startsWith(t)),
    });
  }
  return found;
}

/**
 * An excerpt of the first text that holds a matching word, cut at words around it, as segments
 * so a renderer marks the matches without parsing HTML. Without a match in the body (the title
 * matched), the start of the first text; an item without body text has an empty excerpt.
 */
export function searchExcerpt(body: readonly string[], tokens: readonly string[]): SearchSegment[] {
  let text = body[0] ?? '';
  let found = words(text, tokens);
  for (const candidate of body) {
    const w = words(candidate, tokens);
    if (w.some((x) => x.match)) {
      text = candidate;
      found = w;
      break;
    }
  }
  if (!text) return [];
  const first = found.find((w) => w.match)?.start ?? 0;
  let from = Math.max(0, first - EXCERPT_LENGTH / 3);
  let to = Math.min(text.length, from + EXCERPT_LENGTH);
  // Move both ends to a word boundary, so no word is cut in half.
  const inside = found.find((w) => w.start < from && w.end > from);
  if (inside) from = inside.end;
  const tail = found.find((w) => w.start < to && w.end > to);
  if (tail) to = tail.start;
  const segments: SearchSegment[] = [];
  const push = (value: string, match: boolean) => {
    if (!value) return;
    const last = segments.at(-1);
    if (last && last.match === match) last.text += value;
    else segments.push({ text: value, match });
  };
  let at = from;
  for (const w of found) {
    if (w.start < from || w.end > to) continue;
    push(text.slice(at, w.start), false);
    push(text.slice(w.start, w.end), w.match);
    at = w.end;
  }
  push(text.slice(at, to), false);
  const first_ = segments[0];
  if (first_) first_.text = first_.text.trimStart();
  const last = segments.at(-1);
  if (last) last.text = last.text.trimEnd();
  if (from > 0 && first_) segments.unshift({ text: '… ', match: false });
  if (to < text.length && last) segments.push({ text: ' …', match: false });
  return segments.filter((s) => s.text);
}

export const PublishedSearchResult = z.object({
  id: z.string().guid(),
  type: ContentType,
  slug: Slug,
  locale: Locale,
  title: z.string(),
  /** Part of the text around the first match; `match` marks the words that matched. */
  excerpt: z.array(SearchSegment),
  publishedAt: z.string().datetime({ offset: true }),
});
export type PublishedSearchResult = z.infer<typeof PublishedSearchResult>;

export const findPublished = defineUseCase({
  name: 'content.published.find',
  kind: 'query',
  description:
    'Search the published pages and articles everyone may read, in one locale: every word of the question must start a word of the title or text.',
  requires: 'content:read',
  input: z.object({
    q: z.string().max(MAX_SEARCH_QUERY),
    locale: Locale,
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1),
    limit: z.number().int().min(1).max(20).default(10),
  }),
  output: z.object({
    items: z.array(PublishedSearchResult),
    /** The next page, or null: this was the last one a visitor can ask for. */
    next: z.number().int().nullable(),
  }),
  examples: [{ input: { q: 'buurt', locale: 'nl' } }],
  async handler(ctx, { q, locale, page, limit }) {
    const tokens = queryTokens(q);
    if (!tokens.length) return { items: [], next: null };
    const hits = await ctx.content.searchPublished(
      { tokens, locale },
      (page - 1) * limit,
      limit + 1
    );
    const items: PublishedSearchResult[] = [];
    for (const hit of hits.slice(0, limit)) {
      // The second access decision: the revision the pointer names, read again.
      const revision = await ctx.content.revision(hit.itemId, hit.revisionId);
      if (!revision || !searchEntry(revision.document, locale)) continue;
      const texts = searchTexts(revision.document, locale);
      items.push({
        id: hit.itemId,
        type: hit.type,
        slug: hit.slug,
        locale,
        title: texts.title,
        excerpt: searchExcerpt(texts.body, tokens),
        publishedAt: hit.publishedAt.toISOString(),
      });
    }
    return { items, next: hits.length > limit && page < MAX_SEARCH_PAGE ? page + 1 : null };
  },
});
