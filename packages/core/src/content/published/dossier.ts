// The dossier box under a published page or article (MY-260, brief dossiers): for each dossier the
// document names, in its order, the dossier's title and lead as a link and up to three other
// members, newest first. Read with the item, so every representation that carries the item
// (the site, the read route, MCP) carries the same boxes, and the site's ETag, which hashes the
// render model, moves when a dossier's title or its members change.
//
// What shows is what a visitor may see: a dossier that is not published in this locale, is in
// the trash or is no longer a dossier leaves its box out without an error; a member shows only
// when it is published in this locale and public (an overview would show a restricted one as a
// teaser card, but a box of three is a pointer, not an archive). A restricted dossier shows its
// teaser title and lead, the fields a card of it shows anyway. One query for the dossiers and
// one per dossier for its members, at most four.
//
// Rejected: a box resolved by the front alone (the read route and MCP would not have it) and
// counting members in `content_block_refs` (see `model.ts`: the trash would refuse a dossier).

import { z } from 'zod';
import type { TransactionContext } from '../../ports.js';
import { cardDocument } from '../access/projection.js';
import { Slug, type ContentDocument } from '../model.js';
import { OverviewEntry, cardEntry } from './overview.js';

/** How many other members a box lists. */
const BOX_MEMBERS = 3;

export const PublishedDossier = z.object({
  id: z.string().guid(),
  slug: Slug,
  /** The dossier's published revision; part of the host page's ETag. */
  revisionId: z.string().guid(),
  title: z.string(),
  lead: z.string().nullable(),
  /** Other public members published in this locale, newest first, at most three. */
  members: z.array(OverviewEntry),
});
export type PublishedDossier = z.infer<typeof PublishedDossier>;

/** The boxes of `doc` (the item `itemId`) in `locale`; empty when it shows none. */
export async function dossierBoxes(
  ctx: TransactionContext,
  doc: ContentDocument,
  itemId: string,
  locale: string
): Promise<PublishedDossier[]> {
  const ids = doc.showDossier === false ? [] : (doc.dossiers ?? []).map((d) => d.itemId);
  if (!ids.length) return [];
  const rows = await ctx.content.publishedCards(
    { locale, type: 'page', profile: 'dossier', ids, order: 'newest', restricted: true },
    0,
    ids.length
  );
  const site = (await ctx.siteSettings.images()).value;
  const { timeZone } = (await ctx.siteSettings.general()).value;
  const boxes: PublishedDossier[] = [];
  for (const id of ids) {
    const row = rows.find((r) => r.itemId === id);
    if (!row) continue;
    const dossier = cardDocument(row.document);
    const members = await ctx.content.publishedCards(
      { locale, dossierId: id, exclude: [itemId], order: 'newest' },
      0,
      BOX_MEMBERS
    );
    boxes.push({
      id,
      slug: row.slug,
      revisionId: row.revisionId,
      title: dossier.title[locale] ?? '',
      lead: dossier.lead?.[locale] ?? null,
      members: members.map((m) => cardEntry(m, false, locale, site, timeZone)),
    });
  }
  return boxes;
}
