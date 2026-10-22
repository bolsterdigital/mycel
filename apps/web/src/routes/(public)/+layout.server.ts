// Public tenant pages are server-rendered HTML with no client-side JavaScript (ADR 009 rules 1
// and 4): forms post natively and the server answers with a full page. Rejected: hydrating and
// progressively enhancing with `use:enhance`; nothing on these pages needs it yet.
//
// The footer credit (ADR 015 rule 5) is decided here, from the visitor's Principal, so the layout
// only renders what it is given. So is the theme stylesheet (brief #8c § 3): its hashed path and
// the fonts to preload.
import { anonymousPrincipal, entitled, negotiateLocale } from '@mycel/core';
import { ui } from '../../i18n/index.js';
import { runtime } from '#lib/server/runtime.js';
import { sitePath, siteTenant } from '#lib/server/site.js';
import { siteTheme, themePath } from '#lib/server/theme.js';
import type { LayoutServerLoad } from './$types';

export const csr = false;

export const load: LayoutServerLoad = async ({ locals, request }) => {
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
      // Layout and page load in parallel, so the page's negotiated locale is not known yet.
      label: ui(
        negotiateLocale(
          request.headers.get('accept-language'),
          site.tenant.locales,
          site.tenant.defaultLocale
        )
      )('credit.runsOnMycel'),
    },
  };
};
