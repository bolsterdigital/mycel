// The route grammar of a site (brief #8c § 8), as pure functions so the table is unit-testable:
//
//   /                     the page `index`        /<slug>/thanks           its thank-you page
//   /<slug>               a page                  /articles/<slug>         an article
//   /<locale>/...         the same, in a non-default locale of the site
//
// Everything else is a 404: `/index` (the homepage lives at `/`), a reserved page slug such as
// `/articles` and the other list roots until #9, deeper paths, and a slug that is not a `Slug`.
// The default locale never has a prefix and the prefix is never negotiated: the path is the
// locale (ADR 007 rule 3), so a response depends on its URL alone. Rejected: redirecting `/nl/...` on an nl site to `/...`
// (one URL per resource is simpler to cache and to reason about than a redirect table).

import { Slug, contentPath, isReservedPageSlug, type ContentType } from '@mycel/core';

export interface ContentRoute {
  type: ContentType;
  slug: string;
  /** The thank-you page after a form post on this item. */
  thanks: boolean;
}

export function parseContentPath(path: string): ContentRoute | null {
  const parts = path ? path.split('/') : [];
  const thanks = parts.at(-1) === 'thanks';
  if (thanks) parts.pop();
  const valid = (slug: string | undefined): slug is string =>
    slug !== undefined && Slug.safeParse(slug).success;
  if (parts.length === 0) return { type: 'page', slug: 'index', thanks };
  if (
    parts.length === 1 &&
    valid(parts[0]) &&
    parts[0] !== 'index' &&
    !isReservedPageSlug(parts[0])
  )
    return { type: 'page', slug: parts[0], thanks };
  if (parts.length === 2 && parts[0] === 'articles' && valid(parts[1]))
    return { type: 'article', slug: parts[1], thanks };
  return null;
}

/**
 * The locale a path asks for: no prefix is the site's default; a prefix must be one of the
 * site's other locales. `null` is a 404 (the default with a prefix, or a locale the site lacks).
 */
export function localeOf(
  prefix: string | undefined,
  site: { defaultLocale: string; locales: readonly string[] }
): string | null {
  if (prefix === undefined) return site.defaultLocale;
  return prefix !== site.defaultLocale && site.locales.includes(prefix) ? prefix : null;
}

/** The thank-you path of an item: `/thanks` for the homepage, else its path plus `/thanks`. */
export function thanksPath(
  item: { type: ContentType; slug: string },
  locale: string,
  defaultLocale: string
): string {
  const path = contentPath(item, locale, defaultLocale);
  return `${path === '/' ? '' : path}/thanks`;
}
