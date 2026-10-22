// Public tenant pages are server-rendered HTML with no client-side JavaScript (ADR 009 rules 1
// and 4): forms post natively and the server answers with a full page. Rejected: hydrating and
// progressively enhancing with `use:enhance`; nothing on these pages needs it yet.
//
// The footer credit (ADR 015 rule 5) is decided here, from the visitor's Principal, so the layout
// only renders what it is given.
import { anonymousPrincipal, entitled, negotiateLocale } from '@mycel/core';
import { ui } from '../../i18n/index.js';
import { runtime } from '#lib/server/runtime.js';
import { siteTenant } from '#lib/server/site.js';
import type { LayoutServerLoad } from './$types';

export const csr = false;

export const load: LayoutServerLoad = ({ locals, request }) => {
  const site = locals.site;
  if (!site || entitled(anonymousPrincipal(siteTenant(site), []), 'remove_branding'))
    return { credit: null };
  return {
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
