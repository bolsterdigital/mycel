// The donor's return from the payment provider and the hop to its checkout (brief MY-252 PR 2);
// what it shows and why: lib/server/public/giving/donation-return.ts. `no-store` and `noindex`: the
// address is one person's.

import { localeOf } from '#lib/server/public/content-route.js';
import {
  loadDonationReturn,
  requestMemberSignin,
} from '#lib/server/public/giving/donation-return.js';
import { redirect } from '@sveltejs/kit';
import { NO_STORE } from '#lib/server/http/http-cache.js';
import { refuse } from '#lib/server/http/refuse.js';
import { requireSite } from '#lib/server/site.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, setHeaders }) => {
  const site = requireSite(locals);
  const locale = localeOf(params.locale, site.tenant);
  if (!locale) refuse(404);
  locals.lang = locale;
  setHeaders({ 'cache-control': NO_STORE, 'x-robots-tag': 'noindex' });
  return { locale, ...(await loadDonationReturn(site, locale, params.token, url)) };
};

export const actions: Actions = {
  // "Send me a sign-in link" after a membership: a 303 back to this page, so a refresh sends
  // nothing again.
  signin: async ({ locals, params, url, setHeaders }) => {
    const site = requireSite(locals);
    const locale = localeOf(params.locale, site.tenant);
    if (!locale) refuse(404);
    setHeaders({ 'cache-control': NO_STORE });
    redirect(303, await requestMemberSignin(site, locale, params.token, url));
  },
};
