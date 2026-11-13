// Public tenant pages are server-rendered HTML with no client-side JavaScript (ADR 009 rules 1
// and 4): forms post natively and the server answers with a full page. Rejected: hydrating and
// progressively enhancing with `use:enhance`; nothing on these pages needs it yet.
//
// The chrome and its footer credit (ADR 015 rule 5) come from `chromeModel`, which the item
// previews share, so the layout only renders what it is given. So does the theme
// stylesheet (brief #8c § 3): its hashed path and the fonts to preload. On a content path the
// chrome's language is the path's locale (brief #8c § 8), so a cached page never depends on
// Accept-Language; elsewhere (`confirm`) it is negotiated like the page itself.
import { negotiateLocale } from '@mycel/core';
import { chromeModel } from '#lib/server/public/chrome.js';
import { localeOf } from '#lib/server/public/content-route.js';
import { sitePath } from '#lib/server/site.js';
import { siteTheme, themePath } from '#lib/server/public/theme.js';
import type { LayoutServerLoad } from './$types';

export const csr = false;

/** The route of every content path (`[[locale=locale]]/[...path]`). */
const CONTENT_ROUTE = /\/\[\[locale=locale\]\]\/(?:\[\.\.\.path\]|people\/\[slug\])$/;

export const load: LayoutServerLoad = async ({ locals, request, params, route, setHeaders }) => {
  const site = locals.site;
  if (!site) return { credit: null, theme: null, chrome: null, locale: 'en' };
  const { hash, preload } = await siteTheme(site);
  const theme = { href: sitePath(site, themePath(hash)), preload };
  // A content path has its language in the address; anything else depends on the visitor's.
  if (!CONTENT_ROUTE.test(route.id ?? '')) setHeaders({ vary: 'accept-language' });
  const locale = CONTENT_ROUTE.test(route.id ?? '')
    ? (localeOf(params.locale, site.tenant) ?? site.tenant.defaultLocale)
    : negotiateLocale(
        request.headers.get('accept-language'),
        site.tenant.locales,
        site.tenant.defaultLocale
      );
  // A page that loads sets this itself; one that fails still gets `lang` from here.
  locals.lang ??= locale;
  return { theme, locale, ...(await chromeModel(site, locale, sitePath(site, ''))) };
};
