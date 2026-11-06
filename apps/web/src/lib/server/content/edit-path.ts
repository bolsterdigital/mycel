// Where the edit screen's actions send the browser: the item's address with what the redirect
// adds, and the two outcomes of a save that merged (ADR 026 rule 4): every redirect names the
// revision it merged with (`merged`), and an action that would pin that revision is not taken
// (`held`). Apart from the route, which is at its size ceiling. Rejected: a session flash, which
// a screen without JavaScript and a second tab would not share.

import { redirect } from '@sveltejs/kit';

/** What a save that came before an action knows about its merge and where the screen was. */
export interface Merged {
  tenant: { slug: string };
  editing: string | null;
  mergedWith: string | null;
}

/**
 * The edit screen's address: the item, whatever the redirect adds, and the locale when it is
 * not the one the screen shows anyway.
 */
export const itemPath = (
  tenant: string,
  itemId: string,
  locale: string | null | undefined,
  query: Record<string, string> = {},
  hash = ''
) => {
  const q = new URLSearchParams({ ...query, ...(locale ? { locale } : {}) });
  // `saved` and `held` are flags without a value, as the screen reads them.
  const search = q.toString().replace(/(^|&)(saved|held)=(?=&|$)/g, '$1$2');
  return `/admin/${tenant}/content/${itemId}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`;
};

/** The actions that put one revision live or on a schedule, or approve it: held after a merge. */
export const PINS = new Set<string>(['publish', 'schedule', 'repin']);

/** The redirect's `merged`: the revision the save merged with, for the notice (`load`). */
export const mergedQuery = (saved: Merged): Record<string, string> =>
  saved.mergedWith ? { merged: saved.mergedWith } : {};

/**
 * An action that pins a revision, not taken because the save before it merged: the screen comes
 * back on the merged revision, says with whose save and that the action was not taken, and the
 * editor chooses it again. Without JavaScript too: it is the redirect of the one form.
 */
export function held(saved: Merged, itemId: string): never {
  redirect(
    303,
    itemPath(saved.tenant.slug, itemId, saved.editing, { held: '', ...mergedQuery(saved) })
  );
}
