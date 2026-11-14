// The visitor's site search (`/search?q=`): one GET form and server-rendered results from
// `content.published.find`, which only ever finds public, indexable published locales and takes
// title and excerpt from the live revision. This adapter turns the result into links, dates and
// page links; it decides nothing about access.
//
// Input: `q` is trimmed, its whitespace folded and cut at MAX_SEARCH_QUERY, so an overlong
// address still answers (the form field has the same maxlength); `page` is 1 to MAX_SEARCH_PAGE,
// anything else is a 404 rather than a silent first page, so a crawler that invents numbers gets
// nowhere. Rejected: a 400 for an overlong `q` (a pasted sentence is a visitor's mistake, not an
// attack, and the cut is what the use case would search anyway).
//
// Cost (anonymous, so the route bounds it): ten results a page, at most twenty pages, at most
// eight tokens of two or more characters (core's `queryTokens`). Each result reads its revision
// once more, so a page is one index query plus at most ten revision reads. The response is
// public and cached like a content page; results hold nothing a cached content page does not.
// Measured (2026-11-14, 100 sites of 1,000 items plus one of 20,000, two locales, 250 words a
// body): Postgres reads the asking site's rows through the primary key, whose first column the
// RLS condition fixes, and filters them; the GIN index over every site is not chosen, so a short
// prefix never walks another site's words. A query costs about 20 ms on a site of 1,000 items
// and 120 to 300 ms on one of 20,000, rising with the size of that site only.
import { createHash } from 'node:crypto';
import {
  anonymousPrincipal,
  contentPath,
  MAX_SEARCH_PAGE,
  MAX_SEARCH_QUERY,
  useCases,
} from '@mycel/core';
import { searchPath } from '../../public/search-path.js';
import { refuse } from '../http/refuse.js';
import { runtime } from '../runtime.js';
import { sitePath, siteTenant, siteUrls, type Site } from '../site.js';

/** Results per page; the use case allows up to 20. */
export const SEARCH_PAGE_SIZE = 10;

/** The question as the route searches it: trimmed, single-spaced, at most MAX_SEARCH_QUERY. */
export function searchQuery(raw: string | null): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_QUERY).trim();
}

/** The page number of `?page=`, or null when it is not one a visitor can ask for. */
export function searchPage(raw: string | null): number | null {
  if (raw === null) return 1;
  if (!/^[1-9]\d{0,1}$/.test(raw)) return null;
  const page = Number(raw);
  return page <= MAX_SEARCH_PAGE ? page : null;
}

export async function loadSearchPage(site: Site, locale: string, url: URL) {
  const q = searchQuery(url.searchParams.get('q'));
  const page = searchPage(url.searchParams.get('page'));
  if (page === null || (page > 1 && !q)) refuse(404);
  const { invoker } = runtime();
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  const { defaultLocale } = site.tenant;
  const result = q
    ? await invoker.run(useCases.findPublished, reader, {
        q,
        locale,
        page,
        limit: SEARCH_PAGE_SIZE,
      })
    : { items: [], next: null };
  // A page past the last result is not a page, like an offset past a profile's articles.
  if (page > 1 && !result.items.length) refuse(404);
  const timeZone = (await invoker.run(useCases.getSiteGeneral, reader, {})).value.timeZone;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone });
  const action = sitePath(site, searchPath(locale, defaultLocale));
  const pageHref = (n: number) =>
    `${action}?${new URLSearchParams({ q, ...(n > 1 ? { page: String(n) } : {}) })}`;
  const absolute = await siteUrls(site);
  const view = {
    q,
    page,
    start: (page - 1) * SEARCH_PAGE_SIZE + 1,
    action,
    locale,
    results: result.items.map((item) => ({
      id: item.id,
      href: sitePath(site, contentPath(item, locale, defaultLocale)),
      title: item.title,
      excerpt: item.excerpt,
      publishedAt: item.publishedAt,
      date: date.format(new Date(item.publishedAt)),
    })),
    previous: page > 1 ? pageHref(page - 1) : null,
    next: result.next ? pageHref(result.next) : null,
    // A search page is never a canonical answer: it points at the empty form of its locale.
    canonical: absolute(searchPath(locale, defaultLocale)),
  };
  const etag = `"${createHash('sha256').update(JSON.stringify(view)).digest('base64url')}"`;
  return { view, etag };
}
