// The address of an item on its edit screen: where the public site serves it now, and the old
// addresses that forward to it (`content_redirects`, migration 0062). An editor removes an old
// address with its own button, after the save of the one form like every button there, so what
// was typed is kept; the list only shrinks on that explicit request. Apart from the route, which
// is at its size ceiling. Rejected: removing an old address as part of a save of the slug field,
// which would make a typo in the field able to drop a forward readers still follow.

import { contentPath, useCases, type ContentType, type Principal } from '@mycel/core';
import { redirect, type RequestEvent } from '@sveltejs/kit';
import { text } from '../../admin/admin-actions.js';
import { refusalOf } from '../../http/refuse.js';
import { runtime } from '../../runtime.js';
import { itemPath, mergedQuery, type Merged } from '../edit-path.js';

/** The item's path and its old ones, each in the site's default locale, as the site serves them. */
export async function addressOf(
  principal: Principal,
  item: { id: string; type: ContentType; slug: string },
  defaultLocale: string
) {
  const { redirects } = await runtime().invoker.run(useCases.listRedirects, principal, {
    itemId: item.id,
  });
  const path = (slug: string) =>
    contentPath({ type: item.type, slug }, defaultLocale, defaultLocale);
  return {
    path: path(item.slug),
    oldPaths: redirects.map((r) => ({ slug: r.slug, path: path(r.slug) })),
  };
}

/** What the route's save before an action gives back: the save, or the form's refusal. */
type Commit<E, F> = (
  event: E
) => Promise<{ failure: F } | (Merged & { principal: Principal; data: FormData })>;

/**
 * The "Remove" of one old address: saves the form, then `content.redirect.delete` on the slug the
 * button carries. One already gone (another tab) is no error; the list shows what is left.
 */
export async function dropOldAddress<E extends RequestEvent, F>(event: E, commit: Commit<E, F>) {
  const saved = await commit(event);
  if ('failure' in saved) return saved.failure;
  const itemId = event.params['itemId']!;
  try {
    await runtime().invoker.run(useCases.deleteRedirect, saved.principal, {
      itemId,
      slug: text(saved.data, 'oldSlug'),
    });
  } catch (e) {
    const refusal = refusalOf(e);
    if (refusal.code !== 'not_found' && refusal.code !== 'invalid_input') throw e;
  }
  redirect(
    303,
    itemPath(
      saved.tenant.slug,
      itemId,
      saved.editing,
      { done: 'oldAddressRemoved', ...mergedQuery(saved) },
      'this-item'
    )
  );
}
