// An old address of a page or article (migration 0062): a request the content route could not serve is
// looked up once more as an item's old slug, and forwarded to where the item is now, in the same
// locale, with the query as it came. Core decides whether there is a target at all
// (`content.redirect.resolve`: published and public in that locale), so a forward reveals no
// more than the new address would.
//
// The `Location` is site-relative, through `sitePath`: an alias hostname never gets here (the
// hooks send it to the primary one first, with its path), so relative is the primary host on a
// hostname and the path form in development. 301 with the public cache's lifetime rather than a
// browser's "for ever": an editor can remove the old address or move the item back to it, and a
// reader then reaches what is there within a minute. Rejected: 308, which only differs for a
// non-GET method, and a form post to an old address is not something to carry over.

import { redirect } from '@sveltejs/kit';
import { UseCaseError, anonymousPrincipal, contentPath, useCases } from '@mycel/core';
import { PUBLIC_CACHE } from '../http/http-cache.js';
import { runtime } from '../runtime.js';
import { sitePath, siteTenant, type Site } from '../site.js';
import type { ContentRoute } from './content-route.js';

/** Throws the forward when `route` is an old address with a target; returns otherwise. */
export async function forwardOldAddress(
  site: Site,
  route: Pick<ContentRoute, 'type' | 'slug'>,
  locale: string,
  url: URL,
  setHeaders: (headers: Record<string, string>) => void
): Promise<void> {
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  let target;
  try {
    target = await runtime().invoker.run(useCases.resolveRedirect, reader, { ...route, locale });
  } catch (e) {
    if (e instanceof UseCaseError && (e.code === 'not_found' || e.code === 'invalid_input')) return;
    throw e;
  }
  setHeaders({ 'cache-control': PUBLIC_CACHE });
  redirect(
    301,
    `${sitePath(site, contentPath(target, locale, site.tenant.defaultLocale))}${url.search}`
  );
}
