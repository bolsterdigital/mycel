// Public tenant pages are server-rendered HTML with no client-side JavaScript (ADR 009 rules 1
// and 4): forms post natively and the server answers with a full page. Rejected: hydrating and
// progressively enhancing with `use:enhance`; nothing on these pages needs it yet.
//
// The footer credit (ADR 015 rule 5) is decided here, from the visitor's Principal, so the layout
// only renders what it is given. So is the theme stylesheet (brief #8c § 3): its hashed path and
// the fonts to preload. On a content path the credit's language is the path's locale (brief #8c
// § 8), so a cached page never depends on Accept-Language; elsewhere (`confirm`) it is negotiated
// like the page itself.
import { anonymousPrincipal, entitled, negotiateLocale } from '@mycel/core';
import { ui } from '../../i18n/index.js';
import { localeOf } from '#lib/server/content-route.js';
import { runtime } from '#lib/server/runtime.js';
import { sitePath, siteTenant } from '#lib/server/site.js';
import { siteTheme, themePath } from '#lib/server/theme.js';
import type { LayoutServerLoad } from './$types';

export const csr = false;

/** The route of every content path (`[[locale=locale]]/[...path]`). */
const CONTENT_ROUTE = /\/\[\[locale=locale\]\]\/\[\.\.\.path\]$/;

export const load: LayoutServerLoad = async ({ locals, request, params, route }) => {
  const site = locals.site;
  if (!site) return { credit: null, theme: null };
  const { hash, preload } = await siteTheme(site);
  const theme = { href: sitePath(site, themePath(hash)), preload };
  if (entitled(anonymousPrincipal(siteTenant(site), []), 'remove_branding'))
    return { credit: null, theme };
  return {
    theme,
    credit: {
      href: runtime().config.PLATFORM_CREDIT_URL,
      label: ui(
        CONTENT_ROUTE.test(route.id ?? '')
          ? (localeOf(params.locale, site.tenant) ?? site.tenant.defaultLocale)
          : negotiateLocale(
              request.headers.get('accept-language'),
              site.tenant.locales,
              site.tenant.defaultLocale
            )
      )('credit.runsOnMycel'),
    },
  };
};
