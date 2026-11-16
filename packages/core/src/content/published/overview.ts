// What an overview block shows: the pins on top, then the newest or oldest published
// articles or pages that match the block's filter, as cards with the featured title, summary and
// image of each published revision in this locale. Only `access: public` revisions; restricted
// items join with reader access (ADR 016). One query for the pins and one for the list, never one per card.
//
// Pages: page 1 shows the pins that are published here and fills up to the limit; page n > 1
// continues the same list where page n - 1 stopped, without pins, so an archive reads as one
// list. A pin that is not published in this locale drops out and the list fills its place.
//
// The date is the first publication in this locale, the moment a reader calls "new": a typo fixed
// and republished later does not move an old article to the top. Rejected: the latest
// publication (`content.published.list` orders by it for crawlers, which want the change) and a
// cursor (a page link is `?p=2`; an offset over a list that grows at the top shifts by the new
// articles, which is what an archive shows anyway).

import { z } from 'zod';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import type { TransactionContext } from '../../ports.js';
import { exampleId } from '../../util/ids.js';
import { ContentType, Slug, canonicalTag } from '../model.js';
import { effectiveOf } from '../header/effective.js';
import { OverviewProps } from '../blocks/overview.js';
import type { PublishedCardRow } from '../ports.js';
import '../ports.js';
import '../../theme/ports.js';

/** How far `?p=` goes: 100 pages of 24 is further back than anyone pages by hand. */
export const OVERVIEW_MAX_PAGE = 100;

export const OverviewEntry = z.object({
  id: z.string().guid(),
  type: ContentType,
  slug: Slug,
  /** The published revision the card shows; part of the host page's ETag. */
  revisionId: z.string().guid(),
  /** First publication in this locale. */
  date: z.string().datetime({ offset: true }),
  /** Featured title, else title. */
  title: z.string(),
  /** Featured description, else lead, else first paragraph. */
  summary: z.string().nullable(),
  /** The featured image along the chain (own, hero, the site's default). */
  imageId: z.string().guid().nullable(),
  pinned: z.boolean(),
});
export type OverviewEntry = z.infer<typeof OverviewEntry>;

export const Overview = z.object({
  entries: z.array(OverviewEntry),
  /** Another page follows; the block links to it only with `archive` on. */
  older: z.boolean(),
});
export type Overview = z.infer<typeof Overview>;

export async function overviewOf(
  ctx: TransactionContext,
  props: OverviewProps,
  locale: string,
  page: number
): Promise<Overview> {
  const limit = Number(props.limit);
  const pinIds = props.pinned.map((p) => p.itemId);
  const site = (await ctx.siteSettings.images()).value;
  const entry = (row: PublishedCardRow, pinned: boolean): OverviewEntry => {
    const effective = effectiveOf(row.document, locale, site);
    return {
      id: row.itemId,
      type: row.type,
      slug: row.slug,
      revisionId: row.revisionId,
      date: row.firstPublishedAt.toISOString(),
      title: effective.title.text,
      summary: effective.summary.text,
      imageId: effective.images.featured.mediaId,
      pinned,
    };
  };

  // The pins as page 1 shows them, in the editor's order; their count decides where the list
  // starts on every page, so page 2 continues page 1 exactly.
  const pinRows = pinIds.length
    ? await ctx.content.publishedCards({ locale, ids: pinIds, order: 'newest' }, 0, pinIds.length)
    : [];
  const pins = pinIds.flatMap((id) => pinRows.filter((r) => r.itemId === id).slice(0, 1));
  const shownPins = Math.min(pins.length, limit);
  const first = limit - shownPins;
  const offset = page === 1 ? 0 : first + (page - 2) * limit;
  const take = page === 1 ? first : limit;
  const rows = await ctx.content.publishedCards(
    {
      locale,
      type: props.source,
      ...(props.sectionId ? { sectionId: props.sectionId } : {}),
      ...(props.tags.length ? { tags: props.tags.map((t) => canonicalTag(t.tag)) } : {}),
      exclude: pinIds,
      order: props.order,
    },
    offset,
    take + 1
  );
  return {
    entries: [
      ...(page === 1 ? pins.slice(0, shownPins).map((r) => entry(r, true)) : []),
      ...rows.slice(0, take).map((r) => entry(r, false)),
    ],
    older: rows.length > take,
  };
}

export const getOverview = defineUseCase({
  name: 'content.overview.get',
  kind: 'query',
  requires: 'content:read',
  description:
    'Read what an overview block shows in one locale: its pinned items, then the published public articles or pages that match its filter, newest or oldest first, as cards with featured title, summary and image; page 2 and on continue the list without the pins.',
  input: z
    .object({
      props: OverviewProps,
      locale: Locale,
      page: z.number().int().min(1).max(OVERVIEW_MAX_PAGE).default(1),
    })
    .strict(),
  output: Overview,
  examples: [
    {
      input: {
        props: { sectionId: exampleId(0x5ec1), limit: '6' },
        locale: 'nl',
      },
      note: 'The six newest public articles of one section.',
    },
  ],
  async handler(ctx, { props, locale, page }) {
    return overviewOf(ctx, props, locale, page);
  },
});
