// "Read more" under a published article (MY-304, brief read-more): up to three other articles, the
// newest of the article's own section first, filled up with the newest of the site. Read with the
// item, like the dossier boxes (`dossier.ts`), so the site, the read route and MCP carry the same
// cards and the site's ETag, which hashes the render model, moves when a new article appears.
//
// What shows is what an overview would show: published in this locale, outside the trash, a
// restricted article as its teaser card (`cardEntry` reads `cardDocument`). Never the article
// itself, and never an article a dossier box under it already lists, so no card appears twice on
// one page. A site switches it off with `SiteGeneral.readMore: 'off'`; pages, events and campaign
// landings never have it. Two queries at most.
//
// Rejected: choosing by tags or reading behaviour (until an editorial team asks), a per-article
// switch (the brief's "not now") and a block in the document (the editor would have to place it
// on every article, and an old revision would keep a stale list).

import type { TransactionContext } from '../../ports.js';
import type { ContentDocument } from '../model.js';
import type { PublishedDossier } from './dossier.js';
import { OverviewEntry, cardEntry } from './overview.js';
import { cardRecordings } from './recording.js';

/** How many cards the row shows at most. */
const READ_MORE_CARDS = 3;

/** The cards under `doc` (the item `itemId`) in `locale`; empty when it shows none. */
export async function readMore(
  ctx: TransactionContext,
  doc: ContentDocument,
  itemId: string,
  locale: string,
  dossiers: readonly PublishedDossier[]
): Promise<OverviewEntry[]> {
  if (doc.type !== 'article') return [];
  const general = (await ctx.siteSettings.general()).value;
  if (general.readMore === 'off') return [];
  const exclude = [itemId, ...dossiers.flatMap((d) => d.members.map((m) => m.id))];
  const base = { locale, type: 'article' as const, order: 'newest' as const, restricted: true };
  const rows = doc.sectionId
    ? await ctx.content.publishedCards(
        { ...base, sectionId: doc.sectionId, exclude },
        0,
        READ_MORE_CARDS
      )
    : [];
  if (rows.length < READ_MORE_CARDS)
    rows.push(
      ...(await ctx.content.publishedCards(
        { ...base, exclude: [...exclude, ...rows.map((r) => r.itemId)] },
        0,
        READ_MORE_CARDS - rows.length
      ))
    );
  const site = (await ctx.siteSettings.images()).value;
  const recordings = await cardRecordings(
    ctx,
    rows.map((r) => r.document)
  );
  return rows.map((row) => cardEntry(row, false, locale, site, general.timeZone, recordings));
}
