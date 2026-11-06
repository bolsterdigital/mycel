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
