// What a feed or `llms.txt` lists: the newest published articles (or pages) of a site in one
// locale, optionally of one section or one author, with the featured title and summary of each
// published revision. It reads the same rows as an overview block (`publishedCards`): the
// publication pointers in that locale, never a draft or a zone, one query per call. A restricted
// item is in a feed as its teaser (ADR 016 rule 3, ADR 018 rule 7): title and summary from
// `cardDocument`, so explicit card text or the lead and never a paragraph, marked `restricted`;
// its link serves the same teaser with the prompt to sign in. `llms.txt` leaves those out.
//
// A feed is for readers who follow the site, so it leaves out what the site asked search engines
// to skip: a `noindex` revision and one whose canonical points to another address (that text
// belongs to the other site's feed). The same rule keeps both out of `llms.txt` and the sitemap.
//
// The date is the first publication in this locale, as on a card: a typo fixed and republished
// later does not push an old article to the top of a reader's feed. A section or author is named
// by its slug, as in a URL; an unknown section, or a person whose public page is off, is a
// `not_found`, so a feed exists exactly where the public page of that person does.
//
// Rejected: leaving restricted items out of the feed (an item behind the paywall would vanish for
// everyone who follows the site), a full-text entry for a signed-in reader (a feed is one public
// document; per-reader signed feeds are later, ADR 016 rule 5), and paging (a feed shows the
// newest; a reader's client keeps the older entries).

import { z } from 'zod';
import { notFound } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { ContentType, Slug, type ContentDocument } from '../model.js';
import { cardDocument } from '../access/projection.js';
import { effectiveOf } from '../header/effective.js';
import { personPageEnabled } from '../people/public.js';
import '../ports.js';
import '../../theme/ports.js';

/** Most entries one feed asks for; `llms.txt` asks for this many of each type. */
export const FEED_MAX = 100;

export const FeedEntry = z.object({
  id: z.string().guid(),
  type: ContentType,
  slug: Slug,
  revisionId: z.string().guid(),
  /** First publication in this locale. */
  date: z.string().datetime({ offset: true }),
  /** Featured title, else title. */
  title: z.string(),
  /** Featured description, else lead, else first paragraph (never for a restricted item). */
  summary: z.string().nullable(),
  /** For members or a tier: its address serves the teaser; `llms.txt` leaves it out. */
  restricted: z.boolean(),
});
export type FeedEntry = z.infer<typeof FeedEntry>;

/** Left out of every list a crawler or reader follows: noindex, or canonical elsewhere. */
export function indexable(doc: Pick<ContentDocument, 'seo'>): boolean {
  return !doc.seo.noindex && !doc.seo.canonical;
}

export const getFeed = defineUseCase({
  name: 'content.feed.get',
  kind: 'query',
  requires: 'content:read',
  description:
    'Read the newest published articles (or pages) of the site in one locale, optionally of one section or one author (by slug), with featured title and summary, for RSS, Atom and llms.txt. A restricted item is its teaser, marked `restricted`. Leaves out noindex items and items whose canonical is elsewhere.',
  input: z
    .object({
      locale: Locale,
      type: ContentType.default('article'),
      section: Slug.optional(),
      author: Slug.optional(),
      limit: z.number().int().min(1).max(FEED_MAX).default(20),
    })
    .strict(),
  output: z.object({
    /** The section's or author's name in this locale, for the feed's title; null for the site. */
    name: z.string().nullable(),
    entries: z.array(FeedEntry),
  }),
  examples: [{ input: { locale: 'nl', limit: 20 }, note: "The site's twenty newest articles." }],
  async handler(ctx, { locale, type, section, author, limit }) {
    let name: string | null = null;
    let sectionId: string | undefined;
    let authorId: string | undefined;
    if (section) {
      const found = await ctx.sections.findBySlug(section);
      if (!found) throw notFound('section');
      sectionId = found.id;
      name = found.title[locale] ?? null;
    }
    if (author) {
      const found = await ctx.authors.findBySlug(author);
      if (!found || !(await personPageEnabled(ctx, found))) throw notFound('public person');
      authorId = found.id;
      name = found.name;
    }
    const site = (await ctx.siteSettings.images()).value;
    const rows = await ctx.content.publishedCards(
      {
        locale,
        type: sectionId || authorId ? 'article' : type,
        ...(sectionId ? { sectionId } : {}),
        ...(authorId ? { authorId } : {}),
        order: 'newest',
        restricted: true,
      },
      0,
      // Room for the rows `indexable` drops, so a few noindex items on top do not shorten it.
      limit * 2
    );
    return {
      name,
      entries: rows
        .filter((r) => indexable(r.document))
        .slice(0, limit)
        .map((r) => {
          const doc = cardDocument(r.document);
          const effective = effectiveOf(doc, locale, site);
          return {
            id: r.itemId,
            type: r.type,
            slug: r.slug,
            revisionId: r.revisionId,
            date: r.firstPublishedAt.toISOString(),
            title: effective.title.text,
            summary: effective.summary.text,
            restricted: doc.access.level !== 'public',
          };
        }),
    };
  },
});
