// Where the edit screen's actions send the browser: the item's address with what the redirect
// adds, and the two outcomes of a save that merged (ADR 026 rule 4): every redirect names the
// revision it merged with (`merged`), and an action that would pin that revision is not taken
// (`held`). Apart from the route, which is at its size ceiling. Rejected: a session flash, which
// a screen without JavaScript and a second tab would not share.

import type { Revision } from '@mycel/core';
import { redirect } from '@sveltejs/kit';

/** What a save that came before an action knows about its merge and where the screen was. */
export interface Merged {
  tenant: { slug: string };
  editing: string | null;
  mergedWith: string | null;
}

/** A block operation's rebase is recorded in its newly written revision (ADR 027). */
export const mergedWithOf = (made: Pick<Revision, 'provenance'>): string | null =>
  made.provenance && 'merged' in made.provenance ? made.provenance.merged.latestRevisionId : null;

/**
 * A block operation after the save (ADR 027): one on an older base that was rebased onto the
 * newest revision says so in its revision's provenance, and is then a merge like a save that
 * merged: the redirect names it and the screen says with whose save. Returns `made` for the
 * caller. A merge the save already found stays the one named.
 */
export function noteRebase<T extends { revision: Pick<Revision, 'id' | 'provenance'> } | void>(
  saved: Merged,
  made: T
): T {
  if (made && !saved.mergedWith) saved.mergedWith = mergedWithOf(made.revision);
  return made;
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
