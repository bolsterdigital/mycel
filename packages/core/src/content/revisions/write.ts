// Revision persistence shared by normal saves and exact-state bulk restoration. Rejected:
// implementing undo as an old-base save, which would merge and erase the actual pre-effect state.
import type { TransactionContext } from '../../ports.js';
import type { ItemRecord } from '../ports.js';
import { documentMedia, type ContentDocument, type ContentItem, type Revision } from '../model.js';
import { draftLocale } from '../lifecycle.js';
import { assertReferences, recordMediaUsages, toContentItem } from '../service.js';

/** The one shape of a new revision, for a new item and for every write after it. */
export const newRevision = (
  ctx: TransactionContext,
  itemId: string,
  document: ContentDocument,
  now: Date,
  provenance?: Revision['provenance']
): Revision => ({
  id: ctx.ids.next(),
  itemId,
  createdAt: now.toISOString(),
  actor: ctx.principal.actor,
  ...(provenance ? { provenance } : {}),
  document,
});

/** Restore an immutable pre-effect document only after the bulk undo's exact-state checks. */
export async function restoreRevision(
  ctx: TransactionContext,
  item: ItemRecord,
  previous: Revision,
  provenance: Revision['provenance']
): Promise<{ item: ContentItem; revision: Revision }> {
  return storeRevision(ctx, item, previous.document, provenance);
}

export async function storeRevision(
  ctx: TransactionContext,
  item: ItemRecord,
  doc: ContentDocument,
  provenance?: Revision['provenance']
): Promise<{ item: ContentItem; revision: Revision }> {
  await assertReferences(ctx, doc);
  const now = ctx.clock.now();
  const revision = newRevision(ctx, item.id, doc, now, provenance);
  const next: ItemRecord = {
    ...item,
    title: doc.title,
    defaultLocale: doc.defaultLocale,
    locales: doc.locales,
    latestRevisionId: revision.id,
    updatedAt: now,
    publication: doc.locales.map(
      (l) => item.publication.find((s) => s.locale === l) ?? draftLocale(l)
    ),
  };
  await ctx.content.insertRevision(revision);
  await recordMediaUsages(
    ctx,
    `item:${revision.itemId}:rev:${revision.id}`,
    revision.document.blocks,
    documentMedia(revision.document)
  );
  await ctx.content.save(next);
  return { item: toContentItem(next), revision };
}
