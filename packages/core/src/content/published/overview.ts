// What an overview block shows: the pins on top, then the newest or oldest published
// articles or pages that match the block's filter, as cards with the featured title, summary and
// image of each published revision in this locale. A restricted item is a card like any other,
// drawn from its teaser without blocks (`cardDocument`: title, explicit lead or card text, header
// image) and marked `restricted`, the same for every visitor and reader, so the host page stays
// one public cache entry (ADR 018 rules 7 and 8). The renderer shows an image only when the asset
// itself is public. An agenda leaves restricted events out: when and where is what a members'
// meeting keeps to its members (`teaserDocument`), and an agenda sorts by it. One query for the
// pins and one for the list, never one per card; a Video/audio article's card adds its recording
// (`recording.ts`), one video read per distinct recording on the page.
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
//
// Events: an agenda lists pages with the `event` profile, upcoming or past on the site's
// wall clock at the moment the page is read, never stored, so an event moves to "past" when it
// ends without anyone saving anything. The card carries when and where; the host page's ETag
// hashes the render model, so the list it shows after the turn is a new tag, not a 304.
//
// Dossiers (MY-260): `dossierId` keeps the articles or pages whose published revision names that
// dossier, so a member taken out of it leaves the list when that change is published; the source
// `dossier` lists the dossier pages themselves, newest or oldest first like any page.
//
// A fixed selection (source `selection`, MY-289) is the pins and nothing else: every one that is
// published in this locale, in the editor's order, without `limit`, without a list query and
// without a page 2. A pin that is gone leaves no place to fill.
//
// A campaign index (source `campaign`, MY-292) lists the landing pages of the site's campaigns of
// one kind that are not archived, published and public in this locale, newest or oldest first
// like any page; each card carries where its campaign stands now (`campaignStandings`), so a
// closed petition stays findable with its result and a hidden counter stays hidden. A restricted
// landing page is left out, as its campaign card is (ADR 033 rule 5). Archived campaigns never
// show: archiving is how a site takes one out of its public history.

import { z } from 'zod';
import { ImagePlacement, placementFor } from '../../media/placement.js';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import type { TransactionContext } from '../../ports.js';
import { exampleId } from '../../util/ids.js';
import { ContentType, Slug, canonicalTag } from '../model.js';
import { PublishedEvent, projectEvent } from './event.js';
import { wallClock } from '../../util/time-zone.js';
import { effectiveOf, type ChainSite } from '../header/effective.js';
import { cardDocument } from '../access/projection.js';
import { OverviewProps } from '../blocks/overview.js';
import type { PublishedCardRow } from '../ports.js';
import { CampaignStanding, campaignStandings } from '../../campaigns/card.js';
import { CardRecording, NO_RECORDINGS, cardRecording, cardRecordings } from './recording.js';
import type { CardRecordings } from './recording.js';
import '../ports.js';
import '../../campaigns/ports.js';
import '../../theme/ports.js';

/** How far `?p=` goes: 100 pages of 24 is further back than anyone pages by hand. */
export const OVERVIEW_MAX_PAGE = 100;
/** Campaigns of one kind an index looks through; more than a site runs in its lifetime. */
const INDEX_MAX_CAMPAIGNS = 1000;

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
  imagePlacement: ImagePlacement.optional(),
  /** When and where in this locale, for an event page; null for anything else. */
  event: PublishedEvent.nullable(),
  pinned: z.boolean(),
  /** For members or a tier (ADR 016): the card says so, and its address serves the teaser. */
  restricted: z.boolean(),
  /** In a campaign index, where the campaign of this landing page stands now; absent elsewhere. */
  campaign: CampaignStanding.nullable().optional(),
  /** A Video/audio article's recording: the card shows a play mark and its length (MY-304). */
  recording: CardRecording.optional(),
});
export type OverviewEntry = z.infer<typeof OverviewEntry>;

export const Overview = z.object({
  entries: z.array(OverviewEntry),
  /** Another page follows; the block links to it only with `archive` on. */
  older: z.boolean(),
});
export type Overview = z.infer<typeof Overview>;

/**
 * One card of a published row in `locale`, as an overview shows it: drawn from the card
 * projection of the document (`cardDocument`), so a restricted item shows only its teaser fields.
 * Shared with the dossier box (`dossier.ts`), which lists members as the same cards.
 */
export function cardEntry(
  row: PublishedCardRow,
  pinned: boolean,
  locale: string,
  site: ChainSite,
  timeZone: string,
  recordings: CardRecordings = NO_RECORDINGS
): OverviewEntry {
  const doc = cardDocument(row.document);
  const effective = effectiveOf(doc, locale, site);
  const placement = placementFor(doc.featuredPlacement, effective.images.featured.mediaId);
  const recording = cardRecording(doc, recordings);
  return {
    ...(placement ? { imagePlacement: placement } : {}),
    ...(recording ? { recording } : {}),
    id: row.itemId,
    type: row.type,
    slug: row.slug,
    revisionId: row.revisionId,
    date: row.firstPublishedAt.toISOString(),
    title: effective.title.text,
    summary: effective.summary.text,
    imageId: effective.images.featured.mediaId,
    event: projectEvent(doc, locale, timeZone),
    pinned,
    restricted: doc.access.level !== 'public',
  };
}

export async function overviewOf(
  ctx: TransactionContext,
  props: OverviewProps,
  locale: string,
  page: number
): Promise<Overview> {
  const limit = Number(props.limit);
  const pinIds = props.pinned.map((p) => p.itemId);
  const site = (await ctx.siteSettings.images()).value;
  const { timeZone } = (await ctx.siteSettings.general()).value;
  const entry = (row: PublishedCardRow, pinned: boolean, recordings?: CardRecordings) =>
    cardEntry(row, pinned, locale, site, timeZone, recordings);

  // The pins as page 1 shows them, in the editor's order; their count decides where the list
  // starts on every page, so page 2 continues page 1 exactly.
  const pinRows = pinIds.length
    ? await ctx.content.publishedCards(
        { locale, ids: pinIds, order: 'newest', restricted: true },
        0,
        pinIds.length
      )
    : [];
  const pins = pinIds.flatMap((id) => pinRows.filter((r) => r.itemId === id).slice(0, 1));
  if (props.source === 'selection') {
    const recordings = await cardRecordings(ctx, page === 1 ? pins.map((r) => r.document) : []);
    return { entries: page === 1 ? pins.map((r) => entry(r, true, recordings)) : [], older: false };
  }
  if (props.source === 'campaign') return campaignIndex(ctx, props, locale, page, pins, entry);
  const shownPins = Math.min(pins.length, limit);
  const first = limit - shownPins;
  const offset = page === 1 ? 0 : first + (page - 2) * limit;
  const take = page === 1 ? first : limit;
  const events =
    props.source === 'event'
      ? { when: props.when, now: wallClock(ctx.clock.now(), timeZone) }
      : undefined;
  const rows = await ctx.content.publishedCards(
    {
      locale,
      type: props.source === 'article' ? 'article' : 'page',
      ...(events ? { events } : {}),
      ...(props.source === 'dossier' ? { profile: 'dossier' as const } : {}),
      ...(props.sectionId ? { sectionId: props.sectionId } : {}),
      ...(props.dossierId ? { dossierId: props.dossierId } : {}),
      ...(props.tags.length ? { tags: props.tags.map((t) => canonicalTag(t.tag)) } : {}),
      exclude: pinIds,
      order: props.order,
      restricted: !events,
    },
    offset,
    take + 1
  );
  const listed = [...(page === 1 ? pins.slice(0, shownPins) : []), ...rows.slice(0, take)];
  const recordings = await cardRecordings(
    ctx,
    listed.map((r) => r.document)
  );
  return {
    entries: [
      ...(page === 1 ? pins.slice(0, shownPins).map((r) => entry(r, true, recordings)) : []),
      ...rows.slice(0, take).map((r) => entry(r, false, recordings)),
    ],
    older: rows.length > take,
  };
}

/** One page of a campaign index: the pins, then the landing pages of one kind (MY-292). */
async function campaignIndex(
  ctx: TransactionContext,
  props: OverviewProps,
  locale: string,
  page: number,
  pins: PublishedCardRow[],
  entry: (row: PublishedCardRow, pinned: boolean) => OverviewEntry
): Promise<Overview> {
  const limit = Number(props.limit);
  const campaigns = await ctx.campaigns.list(
    { kind: props.campaignKind, archived: false },
    0,
    INDEX_MAX_CAMPAIGNS
  );
  const standings = await campaignStandings(ctx, campaigns);
  const shownPins = Math.min(pins.length, limit);
  const first = limit - shownPins;
  const offset = page === 1 ? 0 : first + (page - 2) * limit;
  const take = page === 1 ? first : limit;
  const pinIds = pins.map((r) => r.itemId);
  const ids = [...standings.keys()].filter((id) => !pinIds.includes(id));
  // Without `restricted`: a landing page for members only shows no card (ADR 033 rule 5).
  const rows = await ctx.content.publishedCards(
    { locale, type: 'page', ids, order: props.order },
    offset,
    take + 1
  );
  const card = (row: PublishedCardRow, pinned: boolean): OverviewEntry => ({
    ...entry(row, pinned),
    campaign: standings.get(row.itemId) ?? null,
  });
  return {
    entries: [
      ...(page === 1 ? pins.slice(0, shownPins).map((r) => card(r, true)) : []),
      ...rows.slice(0, take).map((r) => card(r, false)),
    ],
    older: rows.length > take,
  };
}

export const getOverview = defineUseCase({
  name: 'content.overview.get',
  kind: 'query',
  requires: 'content:read',
  description:
    "Read what an overview block shows in one locale: for a fixed selection only its chosen items that are published, in their order; otherwise its pinned items, then the published articles, pages or dossier pages that match its filter (section, tags, dossier) (a restricted one as a teaser card marked `restricted`), or the public landing pages of one kind of campaign that is not archived, each with its phase and public count, newest or oldest first, or the upcoming (soonest first) or past (latest first) events on the site's clock now, as cards with featured title, summary, image and, for an event, when and where; page 2 and on continue the list without the pins.",
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
      note: 'The six newest articles of one section.',
    },
  ],
  async handler(ctx, { props, locale, page }) {
    return overviewOf(ctx, props, locale, page);
  },
});
