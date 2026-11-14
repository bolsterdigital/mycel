// The site search (brief site-search § A2): a GET form whose results the server renders, so it
// works without JavaScript and a result page is an ordinary, cacheable address. The language is
// the path's, never Accept-Language. `noindex` in the head and as a header: a results page is
// no content of its own, and a crawler following a shared link must not index it. Rejected: a
// POST form (no address to share or go back to) and `no-store` (results hold only what the
// public pages they link to already show, and a repeated question is the common case).
import { localeOf } from '#lib/server/public/content-route.js';
import { loadSearchPage } from '#lib/server/public/search-page.js';
import { PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import { refuse } from '#lib/server/http/refuse.js';
import { requireSite } from '#lib/server/site.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, setHeaders }) => {
  const site = requireSite(locals);
  const locale = localeOf(params.locale, site.tenant);
  if (!locale) refuse(404);
  const { view, etag } = await loadSearchPage(site, locale, url);
  locals.lang = locale;
  setHeaders({ etag, 'cache-control': PUBLIC_CACHE, 'x-robots-tag': 'noindex' });
  return view;
};
