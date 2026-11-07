// The pure editorial save proposal, shared by single saves and durable dry runs. Rejected:
// invoking a save and rolling it back, which would couple preparation to adapter transactions.
import { requireEntitled } from '../../entitlements/guards.js';
import { UseCaseError, notFound } from '../../errors.js';
import { zodIssues } from '../../invoke.js';
import type { TransactionContext } from '../../ports.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { allBlocks, assignBlockIds, type BlockInput } from '../blocks.js';
import { ContentDocument, type ContentDocumentInput, type Revision } from '../model.js';
import type { ItemRecord } from '../ports.js';
import { adoptAddedBlocks, mergeConflict, mergeSave } from './save.js';

/**
 * Every block type in the tree must be switched on for the site (ADR 015, `blocks.<type>`): one
 * check for documents and patterns alike, so #8b2 only adds types. A block the site already has
 * cannot be saved again once its type is switched off; reading and publishing what exists stay.
 */
export function requireBlockTypes(
  ctx: TransactionContext,
  blocks: readonly { type: string }[]
): void {
  for (const type of new Set(allBlocks(blocks).map((b) => b.type)))
    requireEntitled(ctx.principal, `blocks.${type}`, undefined, { blockType: type });
}

/** The document as stored: ids for new blocks, the full schema (defaults, invariants) re-checked. */
export function finalize(
  ctx: TransactionContext,
  input: ContentDocumentInput,
  blocks: readonly BlockInput[]
): ContentDocument {
  const parsed = ContentDocument.safeParse({
    ...input,
    machineTranslation: input.machineTranslation,
    blocks: assignBlockIds(blocks, () => ctx.ids.next()),
  });
  if (!parsed.success)
    throw new UseCaseError('invalid_input', 'document is not valid', zodIssues(parsed.error));
  requireBlockTypes(ctx, parsed.data.blocks);
  return parsed.data;
}

/** A stale base is a typed conflict before anything is read or written (ADR 018 rule 2). */
export function assertBase(item: ItemRecord, baseRevisionId: string): void {
  if (item.latestRevisionId !== baseRevisionId)
    throw new UseCaseError('conflict', 'the item has a newer revision than baseRevisionId', [
      {
        path: 'baseRevisionId',
        message: 'content.revision.conflict',
        params: { latestRevisionId: item.latestRevisionId },
      },
    ]);
}

/** The validated save proposal, shared by a save and a bulk dry run; never writes content. */
export async function prepareItemSave(
  ctx: TransactionContext,
  item: ItemRecord,
  baseRevisionId: string,
  document: ContentDocumentInput
) {
  if (document.type !== item.type)
    throw new UseCaseError('invalid_input', 'the type of an item never changes', [
      { path: 'document.type', message: 'content.type.immutable' },
    ]);
  const base = await ctx.content.revision(item.id, baseRevisionId);
  // An id that is no revision of this item cannot be merged from: the stale-base refusal.
  if (!base) assertBase(item, baseRevisionId);
  if (!base) throw notFound('revision');
  const latest =
    item.latestRevisionId === baseRevisionId
      ? null
      : await ctx.content.revision(item.id, item.latestRevisionId);
  if (item.latestRevisionId !== baseRevisionId && !latest) throw notFound('revision');
  // A block posted again without the id the first save gave it is that block (a retry).
  const input = latest ? adoptAddedBlocks(base.document, document, latest.document) : document;
  let next = finalize(ctx, input, input.blocks);
  let previous = base.document;
  const merge = latest ? { baseRevisionId, latestRevisionId: latest.id } : null;
  let provenance: Revision['provenance'];
  if (latest) {
    const merged = mergeSave(base.document, next, latest.document);
    if (merged.conflicts.length) throw mergeConflict(item.latestRevisionId, merged.conflicts);
    next = ContentDocument.parse(merged.document);
    // A merge that adds nothing to the newest revision writes nothing: a repeated save.
    if (canonicalJson(next) === canonicalJson(latest.document))
      return { next, previous: latest.document, merge, provenance, unchanged: latest };
    requireBlockTypes(ctx, next.blocks);
    previous = latest.document;
    provenance = { merged: { baseRevisionId, latestRevisionId: item.latestRevisionId } };
  }
  for (const s of item.publication)
    if (!next.locales.includes(s.locale) && (s.publishedRevisionId || s.scheduleId))
      throw new UseCaseError('invalid_input', `locale "${s.locale}" is published or planned`, [
        {
          path: 'document.locales',
          message: 'content.locale.still-live',
          params: { locale: s.locale },
        },
      ]);
  return { next, previous, merge, provenance, unchanged: null };
}
