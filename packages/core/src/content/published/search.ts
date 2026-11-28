// Site search: what a site publishes, found by words, as far as the one who asks may read it.
//
// One text rule, here, for every adapter. `searchTokens` folds text to tokens (NFKD, combining
// marks dropped, lower case, split on everything that is no letter or digit); a document gives a
// title set and a set over title, lead and every localised block field in one locale; a document
// matches when every token of the question is the start of one of its tokens. The memory adapter
// applies `matchesSearch` to the published revisions, Postgres stores the same tokens as config-free
// `tsvector`s and asks a prefix `tsquery`, so both give the same rows in the same order.
//
// Access is decided twice (ADR 016 rule 3). `searchEntry` gives a restricted revision two token
// sets: those of its teaser document (title, lead and the blocks before the boundary, what the
// item's own address shows everyone) and all of them, with the revision's level and tiers. An
// adapter matches the whole text only where `searchOpens` says the asking reader stands in one of
// those tiers now, and the teaser tokens everywhere else; a `noindex` revision or a zone has no
// entry. The use case then reads each hit's published revision again, decides with `hasAccess`,
// and takes title and excerpt from the whole document or from its teaser document, dropping a hit
// that the teaser alone does not carry. The index holds tokens, no readable text, so no excerpt
// can come from a body the reader may not read. A restricted hit is marked `restricted`; its link
// is the item's own, which shows the teaser and the prompt.
//
// Rejected for restricted items: leaving them out whole (a reader cannot find what they signed in
// for, and a visitor could not find the teaser the site publishes for them), and one token set
// filtered after the query (a page of ten could turn into none, and the count of hits would say
// what words a body holds).
//
// A result is a card (MY-308): the image, section or kind, recording and access mark come from
// the card projection the overview draws from (`cardDocument`, `effectiveOf`, `cardRecordings`),
// so a restricted item shows only its teaser's fields. The title stays the item's own title, the
// one the question matched; rejected: the featured title, which can hide the words that matched.
// A hit in a recording (a public item whose recording plays from this site's library) gives up to
// `MAX_SEARCH_MOMENTS` moments: the transcript lines that carry the most tokens, in time order,
// each with its start in whole seconds for the item's `?t=`. Only the recording in the item's
// header (`mediaRecording`, a Video/audio article) has moments, because `?t=` starts that one and
// no other; a recording further down still finds its item, with an excerpt and no moment.
// Rejected: a moment per recording on the page (a link that opens the page at its top would say
// it starts at 12:34 and does not).
//
// Order: hits whose title carries every token first, then newest publication, then item id; the
// `newest` sort leaves the title rank out. A page is a number, capped at `MAX_SEARCH_PAGE`: a
// visitor reads the first pages, and a cursor over a rank that a publication can change buys
// nothing here. Filters (kind, section, period) and the counts beside them follow the rule in
// `search-facets.ts`; the counts come from the adapter's matching rows under the same access
// rule as the list, so a visitor never counts a restricted item that only its body would match.
// An unknown section is `not_found`, as an unknown page of a list is: a filter that names
// nothing is no empty result.
//
// Rejected: a language configuration per locale with stemming (the memory adapter cannot
// reproduce a Snowball stemmer, so the conformance of the two would be a promise instead of a
// test, and a tenant locale without a configuration would silently search differently; prefixes
// already find `fietspad` for `fiets`), `ILIKE` over stored text (a second readable copy of every
// published body that erasure and unpublication would have to chase), and non-localised fields
// (credits, makers, URLs and ids are not what a visitor searches, and credits are what person
// erasure rewrites).

import { z } from 'zod';
import { ImagePlacement, placementFor } from '../../media/placement.js';
import { videoPresentation } from '../../media/video-playback.js';
import { transcriptText, type TranscriptCue } from '../../media/transcript.js';
import { entitled } from '../../entitlements/guards.js';
import { getIntegrationPlacement } from '../../integrations/service.js';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { grantStands, hasAccess } from '../access/model.js';
import { cardDocument, readerAccess, teaserDocument } from '../access/projection.js';
import { allBlocks, blockLocalized } from '../blocks.js';
import { mediaRecording } from '../header/article-profile.js';
import { effectiveOf } from '../header/effective.js';
import { ContentType, Slug, type Access, type ContentDocument } from '../model.js';
import { publicSection, sectionName } from '../public.js';
import { notFound } from '../../errors.js';
import type { PublishedHit } from '../ports.js';
import { CardRecording, cardRecording, cardRecordings } from './recording.js';
import {
  SearchKind,
  SearchPeriod,
  SearchSort,
  searchKind,
  searchSince,
  searchTotal,
} from './search-facets.js';
import '../ports.js';

/** The longest question, in characters; a search box, not a document. */
export const MAX_SEARCH_QUERY = 200;
/** How many tokens of a question count; the rest is ignored. */
export const MAX_SEARCH_TOKENS = 8;
/** A token shorter than this matches nearly every document as a prefix, so it is ignored. */
export const MIN_SEARCH_TOKEN = 2;
/** The last page a visitor can ask for. */
export const MAX_SEARCH_PAGE = 20;
/** How many moments of its recording a result shows. */
export const MAX_SEARCH_MOMENTS = 3;
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

export function transcriptTokens(track: string) {
  return [...new Set(transcriptText(track).flatMap(searchTokens))];
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

/**
 * The distinct tokens of one locale of a revision: those of its title, all of them, and for a
 * restricted revision those of its teaser document, with the access the revision asks for.
 */
export interface SearchEntry {
  title: string[];
  all: string[];
  /** What a visitor without access may match on; null for a public revision. */
  teaser: string[] | null;
  access: { level: Access['level']; tierIds: string[] };
  /** The section the revision names, for the section filter; null for a page and without one. */
  sectionId: string | null;
  /** The article's presentation profile, for the kind filter (`searchKind`); null for a page. */
  profile: string | null;
}

/**
 * Who asks, as the index can test it: the tiers a reader holds a standing grant on now (computed
 * at the read, ADR 019 rule 4). Null for a visitor and for everyone who is no reader.
 */
export interface SearchReader {
  tierIds: readonly string[];
}

function tokenSets(doc: ContentDocument, locale: string): { title: string[]; all: string[] } {
  const texts = searchTexts(doc, locale);
  const title = [...new Set(searchTokens(texts.title))];
  return { title, all: [...new Set([...title, ...texts.body.flatMap(searchTokens)])] };
}

/**
 * What the index holds for one locale of a revision; null when it asks not to be listed, so no
 * adapter has anything to find it by. The teaser tokens come from `teaserDocument`, the document a
 * visitor is served at the item's address, so search finds nothing that address does not show.
 */
export function searchEntry(doc: ContentDocument, locale: string): SearchEntry | null {
  // A zone has no address of its own to find.
  if (doc.seo.noindex) return null;
  if (doc.type === 'page' && doc.profile === 'zone') return null;
  const { level, tierIds = [] } = doc.access;
  const teaser = level === 'public' ? null : tokenSets(teaserDocument(doc), locale).all;
  const article = doc.type === 'article' ? doc : null;
  return {
    ...tokenSets(doc, locale),
    teaser,
    access: { level, tierIds: [...tierIds] },
    sectionId: article?.sectionId ?? null,
    profile: article?.presentation?.profile ?? null,
  };
}

/**
 * Whether a reader may match the whole text of an entry: `hasAccess` over the tiers that stand
 * now. The Postgres adapter states the same rule in SQL; the adapter rules compare the two.
 */
export function searchOpens(access: SearchEntry['access'], reader: SearchReader | null): boolean {
  if (access.level === 'public') return true;
  if (!reader) return false;
  if (access.level === 'members') return true;
  return access.level === 'tier' && access.tierIds.some((id) => reader.tierIds.includes(id));
}

/** The tiers a reader's standing grants open at `now`, for `SearchReader`. */
export function searchReaderOf(
  reader: { grants: readonly { tierId: string; until: string | null }[] } | null,
  now: Date
): SearchReader | null {
  return (
    reader && { tierIds: reader.grants.filter((g) => grantStands(g, now)).map((g) => g.tierId) }
  );
}

const carries = (have: readonly string[], tokens: readonly string[]) =>
  tokens.every((t) => have.some((h) => h.startsWith(t)));

/**
 * Null: no match. Else whether the title alone carries every token, which ranks first. A reader
 * the entry does not open matches on its teaser tokens only; the title is part of every teaser.
 */
export function matchesSearch(
  entry: SearchEntry,
  tokens: readonly string[],
  reader: SearchReader | null = null
): { inTitle: boolean } | null {
  const have = searchOpens(entry.access, reader) ? entry.all : (entry.teaser ?? []);
  if (!tokens.length || !carries(have, tokens)) return null;
  return { inTitle: carries(entry.title, tokens) };
}

/** The order of hits, which both adapters apply; `newest` leaves the title rank out. */
export function compareHits(
  a: Pick<PublishedHit, 'inTitle' | 'publishedAt' | 'itemId'>,
  b: Pick<PublishedHit, 'inTitle' | 'publishedAt' | 'itemId'>,
  sort: SearchSort = 'best'
): number {
  if (sort === 'best' && a.inTitle !== b.inTitle) return a.inTitle ? -1 : 1;
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

export const SearchMoment = z.object({
  /** Whole seconds from the start of the recording, for the item's `?t=`. */
  seconds: z.number().int().nonnegative(),
  /** The transcript line, cut around its first match like an excerpt. */
  segments: z.array(SearchSegment),
});
export type SearchMoment = z.infer<typeof SearchMoment>;

/**
 * The transcript lines that carry the most tokens, at most `MAX_SEARCH_MOMENTS`, in time order;
 * a tie goes to the earlier line. A line without any token is no moment.
 */
export function searchMoments(
  cues: readonly TranscriptCue[],
  tokens: readonly string[]
): SearchMoment[] {
  return cues
    .map((cue, at) => ({
      cue,
      at,
      count: tokens.filter((t) => carries(searchTokens(cue.text), [t])).length,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.at - b.at)
    .slice(0, MAX_SEARCH_MOMENTS)
    .sort((a, b) => a.at - b.at)
    .map(({ cue }) => ({
      seconds: Math.floor(cue.start),
      segments: searchExcerpt([cue.text], tokens),
    }));
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
  /**
   * The item is not for everyone: a visitor sees its teaser, a reader with access all of it. The
   * excerpt is from the teaser unless the asking reader has access.
   */
  restricted: z.boolean(),
  /** What a card names when the article has no section: a page, an article, a Video/audio one. */
  kind: z.enum(['page', 'article', 'media']),
  /** The article's section, as its page names it; null for a page and without one. */
  section: z.object({ slug: Slug, name: z.string() }).nullable(),
  /** The card's image along the chain (own, hero, the site's default), from the card projection. */
  imageId: z.string().guid().nullable(),
  imagePlacement: ImagePlacement.optional(),
  /** A Video/audio article's recording: the card shows a play mark and its length (MY-304). */
  recording: CardRecording.optional(),
  /**
   * `text` when the item's own text carries every token; `recording` when only its transcript
   * completes the match, and a page shows the moments in place of the excerpt.
   */
  foundIn: z.enum(['text', 'recording']),
  /** Where in the header's recording the question was said, in time order; empty elsewhere. */
  moments: z.array(SearchMoment),
});

export const SearchFacetCounts = z.object({
  /** Hits per kind under every filter but the kind; their sum is the count of "all". */
  kinds: z.object({ page: z.number().int(), article: z.number().int(), media: z.number().int() }),
  /**
   * Sections with hits under every filter but the section, by name; the chosen section is listed
   * with zero when it has none, so a form can still show what was chosen.
   */
  sections: z.array(z.object({ slug: Slug, name: z.string(), count: z.number().int() })),
});
export type SearchFacetCounts = z.infer<typeof SearchFacetCounts>;

const NO_FACETS: SearchFacetCounts = { kinds: { page: 0, article: 0, media: 0 }, sections: [] };
export type PublishedSearchResult = z.infer<typeof PublishedSearchResult>;

export const findPublished = defineUseCase({
  name: 'content.published.find',
  kind: 'query',
  description:
    'Search the published pages and articles in one locale: every word of the question must start a word of the title or text. A restricted item is found by its title and teaser, and by its whole text only for a signed-in reader with access; it is marked restricted. Each result carries its card fields (kind, section, image, recording); a hit in the recording of a Video/audio article lists up to three moments with their start in seconds. Filter by kind (page, article, media), section slug and period (week, month, year), sort by best match or newest; the answer counts the hits in total and per kind and section.',
  requires: 'content:read',
  input: z.object({
    q: z.string().max(MAX_SEARCH_QUERY),
    locale: Locale,
    page: z.number().int().min(1).max(MAX_SEARCH_PAGE).default(1),
    limit: z.number().int().min(1).max(20).default(10),
    kind: SearchKind.optional(),
    /** A section's slug: only articles in it. */
    section: Slug.optional(),
    period: SearchPeriod.optional(),
    sort: SearchSort.default('best'),
  }),
  output: z.object({
    items: z.array(PublishedSearchResult),
    /** The next page, or null: this was the last one a visitor can ask for. */
    next: z.number().int().nullable(),
    /** Hits under every filter; may be one more than the pages hold (see the header). */
    total: z.number().int().nonnegative(),
    facets: SearchFacetCounts,
  }),
  examples: [
    { input: { q: 'buurt', locale: 'nl' } },
    { input: { q: 'buurt', locale: 'nl', kind: 'media', period: 'month', sort: 'newest' } },
  ],
  async handler(ctx, { q, locale, page, limit, kind, section, period, sort }) {
    const tokens = queryTokens(q);
    if (!tokens.length) return { items: [], next: null, total: 0, facets: NO_FACETS };
    // The reader of this request, read now from the session row and the live projection; null for
    // a visitor and for every other actor, an operator included (they search as a visitor here).
    const reader = await readerAccess(ctx);
    const now = ctx.clock.now();
    const libraryId =
      ctx.videoProvider &&
      entitled(ctx.principal, 'blocks.video') &&
      (await getIntegrationPlacement.handler(ctx, {})).embeds.includes('bunny-stream')
        ? ctx.videoProvider.libraryId
        : null;
    const site = (await ctx.siteSettings.images()).value;
    // A page of results often shares a section: read each one once.
    const sections = new Map<string, ReturnType<typeof publicSection>>();
    const sectionOf = (doc: ContentDocument) => {
      if (doc.type !== 'article' || !doc.sectionId) return null;
      // Its name falls back to the item's default locale, so that is part of the key.
      const key = `${doc.sectionId}:${doc.defaultLocale}`;
      if (!sections.has(key)) sections.set(key, publicSection(ctx, doc, locale));
      return sections.get(key)!;
    };
    const chosen = section ? await ctx.sections.findBySlug(section) : null;
    if (section && !chosen) throw notFound('section', 'that slug');
    const filter = {
      kind,
      sectionId: chosen?.id,
      since: period ? searchSince(period, now) : undefined,
    };
    const query = { tokens, locale, reader: searchReaderOf(reader, now), libraryId, filter };
    const hits = await ctx.content.searchPublished(
      { ...query, sort },
      (page - 1) * limit,
      limit + 1
    );
    const counts = await ctx.content.searchFacets(query);
    const found: { item: Omit<PublishedSearchResult, 'recording'>; card: ContentDocument }[] = [];
    for (const hit of hits.slice(0, limit)) {
      // The second access decision: the revision the pointer names, read again.
      const revision = await ctx.content.revision(hit.itemId, hit.revisionId);
      const doc = revision?.document;
      const entry = doc && searchEntry(doc, locale);
      if (!doc || !entry) continue;
      const open = hasAccess(reader, doc, now);
      if (!open && !matchesSearch(entry, tokens, null)) continue;
      const texts = searchTexts(open ? doc : teaserDocument(doc), locale);
      let moments: SearchMoment[] = [];
      if (libraryId && doc.access.level === 'public') {
        const header = mediaRecording(doc)?.id;
        for (const block of doc.blocks) {
          if (block.type !== 'video') continue;
          const video = await videoPresentation(ctx, block.props.videoId, locale);
          if (!video) continue;
          texts.body.push(...video.transcriptText);
          if (block.id === header) moments = searchMoments(video.transcript, tokens);
        }
        if (!carries([...entry.all, ...texts.body.flatMap(searchTokens)], tokens)) continue;
      }
      const card = cardDocument(doc);
      const effective = effectiveOf(card, locale, site);
      const imageId = effective.images.featured.mediaId;
      const placement = placementFor(card.featuredPlacement, imageId);
      found.push({
        card,
        item: {
          ...(placement ? { imagePlacement: placement } : {}),
          id: hit.itemId,
          type: hit.type,
          slug: hit.slug,
          locale,
          title: texts.title,
          excerpt: searchExcerpt(texts.body, tokens),
          publishedAt: hit.publishedAt.toISOString(),
          restricted: doc.access.level !== 'public',
          kind: searchKind(doc.type, entry.profile),
          section: await sectionOf(doc),
          imageId,
          foundIn: carries(open ? entry.all : (entry.teaser ?? entry.all), tokens)
            ? 'text'
            : 'recording',
          moments,
        },
      });
    }
    // One video read per distinct recording on the page, as an overview reads them.
    const recordings = await cardRecordings(
      ctx,
      found.map((f) => f.card)
    );
    const items = found.map(({ item, card }): PublishedSearchResult => {
      const recording = cardRecording(card, recordings);
      return recording ? { ...item, recording } : item;
    });
    // The facet's sections by name; one that no longer resolves is left out, as on a card.
    const named = [];
    for (const { sectionId, count } of counts.sections) {
      const found = sectionId === chosen?.id ? chosen : await ctx.sections.get(sectionId);
      if (found) named.push({ slug: found.slug, name: sectionName(found, locale), count });
    }
    if (chosen && !named.some((n) => n.slug === chosen.slug))
      named.push({ slug: chosen.slug, name: sectionName(chosen, locale), count: 0 });
    named.sort((a, b) => a.name.localeCompare(b.name, locale) || (a.slug < b.slug ? -1 : 1));
    return {
      items,
      next: hits.length > limit && page < MAX_SEARCH_PAGE ? page + 1 : null,
      total: searchTotal(counts, kind),
      facets: { kinds: counts.kinds, sections: named },
    };
  },
});
