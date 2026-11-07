// The address field of the edit screen ("This item"): which slug the form was rendered
// with, whether it asks for another, and moving it before the revision is saved. Apart from the
// route, which is at its size ceiling. Rejected: a slug step inside `content.item.update`, which
// would make every revision save a slug write too.

import { useCases, type Principal } from '@mycel/core';
import { runtime } from '../runtime.js';
import { text } from '../admin/admin-actions.js';
import { refusalOf } from '../http/refuse.js';
import { SLUG_ISSUES } from './edit-copy.js';
import type { UiKey } from '../../../i18n/index.js';

/**
 * The slug the form was rendered with (`baseSlug`, next to the field), so a tab that never touched
 * the field cannot move the address back after another tab moved it. A form without it (an older
 * tab) compares with the item's slug, as before. Rejected: comparing with `item.slug` only, which
 * read a stale tab's untouched field as a request to restore the old address.
 */
export function baseSlugOf(item: { slug: string }, data: FormData): string {
  return data.has('baseSlug') ? text(data, 'baseSlug') : item.slug;
}

/** The new slug the form asks for, or null: empty, untouched, already the item's, or no field. */
export function slugChange(item: { slug: string }, data: FormData): string | null {
  const slug = text(data, 'slug').trim();
  return slug && slug !== baseSlugOf(item, data) && slug !== item.slug ? slug : null;
}

/**
 * The slug field of "This item", applied after the base check and the form's own
 * checks and just before the revision is saved: a refused slug then leaves everything as it was
 * and the form comes back with what was typed. The slug lives on the item, not in a revision, so
 * the save that follows keeps its base. The two are separate transactions: a revision core still
 * refuses after the slug moved (a concurrent save in between, a document rule only core knows)
 * leaves the slug moved, which the next save shows. Rejected: one combined use case, which would
 * make every revision save a slug write too. Empty, or a form without the field (an item that
 * was published, an older tab), changes nothing.
 */
export async function moveSlug(
  principal: Principal,
  item: { id: string; slug: string },
  data: FormData
): Promise<{ error: UiKey; status: number; fieldIssues: { name: string; copy: UiKey }[] } | null> {
  const slug = slugChange(item, data);
  if (!slug) return null;
  try {
    await runtime().invoker.run(useCases.updateSlug, principal, { itemId: item.id, slug });
    return null;
  } catch (thrown) {
    const e = refusalOf(thrown);
    if (e.code !== 'conflict' && e.code !== 'invalid_input') throw e;
    const key = e.issues.map((i) => SLUG_ISSUES[i.message]).find(Boolean);
    const copy =
      key ??
      (e.code === 'conflict' ? 'admin.content.error.slugTaken' : 'admin.content.error.slugInvalid');
    // The summary's line names the field and says why; the heading is the save's.
    return {
      error: 'admin.content.error.invalid',
      status: e.code === 'conflict' ? 409 : 400,
      fieldIssues: [{ name: 'slug', copy }],
    };
  }
}
