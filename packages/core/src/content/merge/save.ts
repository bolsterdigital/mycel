// A save on an older base as core stores it (ADR 026): the generic merge of `merge.ts` checked
// against the whole document's rules, and the typed refusal that names each conflicting value.
// Apart from the use case so a front can compute the same proposal (the edit screen does).

import { z } from 'zod';
import { UseCaseError } from '../../errors.js';
import { canonicalJson } from '../../util/canonical-json.js';
import { ContentDocument, type ContentDocumentInput } from '../model.js';
import { mergeDocuments, type MergeConflict, type MergeResult } from './merge.js';

/**
 * A save on an older base (ADR 026): the caller's document merged with what was saved since, per
 * field, locale and block id (`merge.ts`). Valid and without conflict, it is the document to
 * store. A merge that breaks a rule of the whole document (two text blocks side by side, one
 * paywall too many) makes the block list one choice, and if that is not enough the whole
 * document: never a half-merged tree. `schema` is `ContentDocumentInput` for a front that merges
 * a post whose new blocks have no id yet.
 */
export function mergeSave<D extends ContentDocumentInput>(
  base: ContentDocument,
  mine: D,
  theirs: ContentDocument,
  schema: z.ZodType<D> = ContentDocument as unknown as z.ZodType<D>
): MergeResult<D> {
  const merged = mergeDocuments<D>(base as D, mine, theirs as D);
  if (merged.conflicts.length) return merged;
  if (schema.safeParse(merged.document).success) return merged;
  if (!sameBlocks(mine.blocks, base.blocks) && !sameBlocks(theirs.blocks, base.blocks)) {
    const document = { ...merged.document, blocks: mine.blocks };
    if (schema.safeParse(document).success)
      return {
        document,
        conflicts: [
          { path: 'blocks', base: base.blocks, mine: mine.blocks, theirs: theirs.blocks },
        ],
      };
  }
  return { document: mine, conflicts: [{ path: '', base, mine, theirs }] };
}

const sameBlocks = (a: readonly unknown[], b: readonly unknown[]) =>
  canonicalJson(a) === canonicalJson(b);

/**
 * A block without an id in `mine` that equals a block `theirs` added since `base` (same type,
 * version and props) is that block: it takes its id, so the merge takes it once. That is what a
 * repeated save is (a retry after a timeout, a double click): the first one stored the block, the
 * second one carries it again without the id it got. Each added block is claimed once, in order.
 * Rejected: refusing a retry (the 409 of ADR 018, which made a lost response a lost save) and
 * an idempotency key per request (every front and agent would have to send one).
 */
export function adoptAddedBlocks<D extends ContentDocumentInput>(
  base: ContentDocument,
  mine: D,
  theirs: ContentDocument
): D {
  const known = new Set(base.blocks.map((b) => b.id));
  const shape = (b: { type: string; version: number; props: unknown }) =>
    canonicalJson({ type: b.type, version: b.version, props: b.props });
  const added = theirs.blocks.filter((b) => !known.has(b.id)).map((b) => [b.id, shape(b)]);
  if (!added.length || mine.blocks.every((b) => b.id)) return mine;
  const blocks = mine.blocks.map((b) => {
    if (b.id) return b;
    const at = added.findIndex(([, s]) => s === shape(b));
    if (at < 0) return b;
    const [id] = added.splice(at, 1)[0]!;
    return { ...b, id };
  });
  return { ...mine, blocks };
}

/** The typed refusal of a merge with conflicts: the base, the newest, and every path to choose. */
export function mergeConflict(latestRevisionId: string, conflicts: MergeConflict[]): UseCaseError {
  return new UseCaseError(
    'conflict',
    'the item has a newer revision and both changed the same values',
    [
      {
        path: 'baseRevisionId',
        message: 'content.revision.conflict',
        params: { latestRevisionId },
      },
      ...conflicts.map((c) => ({
        path: c.path ? `document.${c.path}` : 'document',
        message: 'content.revision.conflict-value',
      })),
    ]
  );
}
