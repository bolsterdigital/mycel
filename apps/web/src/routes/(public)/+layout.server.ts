// Public tenant pages are server-rendered HTML with no client-side JavaScript (ADR 009 rules 1
// and 4): forms post natively and the server answers with a full page. Rejected: hydrating and
// progressively enhancing with `use:enhance`; nothing on these pages needs it yet.
//
// The chrome and its footer credit (ADR 015 rule 5) come from `chromeModel`, which the item
// previews share, so the layout only renders what it is given. So does the theme
// stylesheet (brief #8c § 3): its hashed path and the fonts to preload. On a content path the
// chrome's language is the path's locale (brief #8c § 8), so a cached page never depends on
// Accept-Language; elsewhere (`confirm`) it is negotiated like the page itself. The browser's
// `theme-color` per mode is the theme's `body` background, and the icon is the site's own logo
// (the chrome's); a site without a logo links an empty icon, so the browser makes no request
// (not even the implicit `/favicon.ico`). Rejected: a generated icon or a platform default,
// which would show a mark the site never chose.
import { negotiateLocale } from '@mycel/core';
import { chromeModel } from '#lib/server/public/chrome.js';
import { localeOf } from '#lib/server/public/content-route.js';
import { sitePath } from '#lib/server/site.js';
import { siteTheme, themePath } from '#lib/server/public/theme.js';
import type { LayoutServerLoad } from './$types';

export const csr = false;

/** The routes whose language is in the path: content, profiles and the site search. */
const CONTENT_ROUTE = /\/\[\[locale=locale\]\]\/(?:\[\.\.\.path\]|people\/\[slug\]|search)$/;

export const load: LayoutServerLoad = async ({ locals, request, params, route, setHeaders }) => {
  const site = locals.site;
  if (!site) return { credit: null, theme: null, chrome: null, locale: 'en' };
  const { hash, preload, colors } = await siteTheme(site);
  const theme = { href: sitePath(site, themePath(hash)), preload, colors };
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
