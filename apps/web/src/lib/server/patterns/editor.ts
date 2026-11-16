// Composed blocks on the edit screen (ADR 013 rule 4 as refined 2026-11-16): save a
// run of the document's blocks as a pattern, and insert a pattern's copy at any insertion point.
// Both are steps after the save of the one form, like every block action, so nothing typed is
// lost. The block chooser names a pattern as `pattern:<id>` in the same `insert` value as a block
// type (`type|place`), so every insertion point offers both without a second control.
// Rejected: checkboxes per block card to pick what to save (a run is what an insert puts back,
// and two selects work without JavaScript), and the native `required` on the name, which would
// block every other button of the one form while the field is empty.

import { UseCaseError, useCases, type BlockInput, type Revision } from '@mycel/core';
import { redirect } from '@sveltejs/kit';
import { text } from '#lib/server/admin/admin-actions.js';
import { blockTry, type Saved } from '#lib/server/content/conflict/block-try.js';
import { itemPath, mergedQuery, noteRebase, type Merged } from '#lib/server/content/edit-path.js';
import { runtime } from '#lib/server/runtime.js';

/** The prefix of a pattern in the block chooser's `insert` value. */
export const PATTERN_CHOICE = 'pattern:';

type Step = Saved & Merged & { data: FormData };
type Place = { at: 'end' } | { before: string };

/** The pattern and place of a chooser value `pattern:<id>|end` or `pattern:<id>|before:<block>`. */
export function patternInsert(choice: string): { patternId: string; place: Place } | null {
  const [value = '', placement = ''] = choice.split('|');
  if (!value.startsWith(PATTERN_CHOICE)) return null;
  const patternId = value.slice(PATTERN_CHOICE.length);
  if (placement === 'end') return { patternId, place: { at: 'end' } };
  const [kind, anchor] = placement.split(':');
  return kind === 'before' && anchor ? { patternId, place: { before: anchor } } : null;
}

/**
 * The run from block `from` to block `to` (either order), without ids, names kept; an id that is
 * not there stands for the first or the last block, so the defaults save the whole document.
 */
export function patternRun(
  blocks: Revision['document']['blocks'],
  from: string,
  to: string
): BlockInput[] {
  const at = (id: string, fallback: number) => {
    const i = blocks.findIndex((b) => b.id === id);
    return i < 0 ? fallback : i;
  };
  const [a, b] = [at(from, 0), at(to, blocks.length - 1)].sort((x, y) => x - y);
  return blocks.slice(a, b + 1).map(({ id: _id, ...block }) => block as BlockInput);
}

/** A pattern's copy where the chooser was, on the revision the save made; lands on its first block. */
export async function insertPatternStep(saved: Step, itemId: string, choice: string) {
  let landing = 'blocks';
  const refused = await blockTry(saved, itemId, async () => {
    const chosen = patternInsert(choice);
    if (!chosen) throw new UseCaseError('invalid_input', 'unknown insertion point');
    const made = noteRebase(
      saved,
      await runtime().invoker.run(useCases.insertPattern, saved.principal, {
        itemId,
        baseRevisionId: saved.revisionId,
        ...chosen,
      })
    );
    if (made.created[0]) landing = `block-${made.created[0]}`;
  });
  if (refused) return refused;
  const done = { done: 'patternInserted', ...mergedQuery(saved) };
  redirect(303, itemPath(saved.tenant.slug, itemId, saved.editing, done, landing));
}

/**
 * The run the form names (`patternFrom`, `patternTo`) of the revision the save made, as a new
 * pattern of the item's type, named in the locale the screen edits.
 */
export async function savePatternStep(saved: Step, itemId: string, locale: string) {
  const name = text(saved.data, 'patternName').trim();
  const refused = await blockTry(
    saved,
    itemId,
    async () => {
      if (!name)
        throw new UseCaseError('invalid_input', 'a pattern needs a name', [
          { path: 'patternName', message: 'pattern.name-required' },
        ]);
      const { invoker } = runtime();
      const { revision } = await invoker.run(useCases.getItem, saved.principal, {
        itemId,
        revisionId: saved.revisionId,
      });
      const blocks = revision.document.blocks;
      await invoker.run(useCases.createPattern, saved.principal, {
        name: { [locale]: name },
        intendedType: revision.document.type,
        blocks: patternRun(blocks, text(saved.data, 'patternFrom'), text(saved.data, 'patternTo')),
      });
    },
    { 'pattern.name-required': 'admin.pattern.save.nameRequired' }
  );
  if (refused) return refused;
  const done = { done: 'patternSaved', ...mergedQuery(saved) };
  redirect(303, itemPath(saved.tenant.slug, itemId, saved.editing, done, 'save-pattern'));
}
