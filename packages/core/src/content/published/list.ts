// The public list of what a site publishes: one row per published locale of an item,
// read from the publication pointers (`content_item_locales.published_revision_id`), never from
// the latest revision. The sitemap reads it now, feeds and `llms.txt` later, so a draft
// saved after publication, an unpublished locale or a pin that has not run yet changes no
// representation (ADR 018 rule 9).
//
// A row is a pointer plus what a representation decides on: `noindex`, the section and the
// access level of the published revision. No title, lead or block leaves through here: a feed
// that needs text asks `content.published.get` per row, which applies the access rule. Restricted
// rows are listed with their level, so a sitemap may name the URL (ADR 018) and a feed can leave
// them out; their body never reaches this module.
//
// Order: newest publication first, then item id and locale ascending, so a cursor is one row and
// two rows never tie. The cursor is that row as `<epoch ms>.<item id>.<locale>`. Rejected: an
// offset (a publication between two requests shifts every later page, so a crawl repeats or
// skips rows) and the item-only order of `content.item.find` (a row is an item in one locale).

import { z } from 'zod';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { MAX_PAGE_SIZE } from '../../util/page-size.js';
import { ContentType, Slug } from '../model.js';
import type { PublishedEntry, PublishedPosition } from '../ports.js';
import '../ports.js';

export const PublishedListEntry = z.object({
  id: z.string().guid(),
  type: ContentType,
  slug: Slug,
  locale: Locale,
  /** Every published locale of the item: the language links its page names. */
  locales: z.array(Locale),
  revisionId: z.string().guid(),
  publishedAt: z.string().datetime({ offset: true }),
  /** When the published revision was saved; a later draft does not move it. */
  updatedAt: z.string().datetime({ offset: true }),
  noindex: z.boolean(),
  sectionId: z.string().guid().nullable(),
  access: z.enum(['public', 'members', 'tier']),
});
export type PublishedListEntry = z.infer<typeof PublishedListEntry>;

const CURSOR = /^(\d{1,15})\.([0-9a-f-]{36})\.([a-z]{2,3}(?:-[A-Z]{2})?)$/;

const PublishedCursor = z.string().regex(CURSOR, 'content.published.cursor.invalid');

function positionOf(cursor: string): PublishedPosition {
  const [, ms, itemId, locale] = CURSOR.exec(cursor)!;
  return { publishedAt: new Date(Number(ms)), itemId: itemId!, locale: locale! };
}

export function publishedCursor(row: Pick<PublishedEntry, 'publishedAt' | 'itemId' | 'locale'>) {
  return `${row.publishedAt.getTime()}.${row.itemId}.${row.locale}`;
}

/**
 * The order of the list, which both adapters apply: `publishedAt` descending at millisecond
 * precision, then item id and locale ascending in code-point order.
 */
export function comparePublished(a: PublishedPosition, b: PublishedPosition): number {
  const time = b.publishedAt.getTime() - a.publishedAt.getTime();
  if (time) return time;
  if (a.itemId !== b.itemId) return a.itemId < b.itemId ? -1 : 1;
  return a.locale < b.locale ? -1 : a.locale > b.locale ? 1 : 0;
}

export const listPublished = defineUseCase({
  name: 'content.published.list',
  kind: 'query',
  description:
    'List the published locales of pages and articles, newest publication first: addresses and publication facts only, for sitemaps and feeds.',
  requires: 'content:read',
  input: z.object({
    type: ContentType.optional(),
    sectionId: z.string().guid().optional(),
    after: PublishedCursor.optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  }),
  output: z.object({ items: z.array(PublishedListEntry), next: z.string().nullable() }),
  examples: [{ input: { type: 'article', limit: 20 } }],
  async handler(ctx, { type, sectionId, after, limit }) {
    const rows = await ctx.content.listPublished(
      { type, sectionId },
      after ? positionOf(after) : null,
      limit + 1
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.itemId,
        type: r.type,
        slug: r.slug,
        locale: r.locale,
        locales: r.locales,
        revisionId: r.revisionId,
        publishedAt: r.publishedAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        noindex: r.noindex,
        sectionId: r.sectionId,
        access: r.access,
      })),
      next: rows.length > limit ? publishedCursor(page.at(-1)!) : null,
    };
  },
});
