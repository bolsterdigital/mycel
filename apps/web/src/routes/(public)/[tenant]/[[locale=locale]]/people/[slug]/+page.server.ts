// URL-owned locales and the public registry projection keep profile HTML cacheable without cookies.
// Rejected: negotiating a profile's language from Accept-Language.
import { Slug } from '@mycel/core';
import { localeOf } from '#lib/server/public/content-route.js';
import { loadPersonPage } from '#lib/server/public/person-page.js';
import { requireSite } from '#lib/server/site.js';
import { refuse } from '#lib/server/http/refuse.js';
import { PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url, setHeaders }) => {
  const site = requireSite(locals);
  const locale = localeOf(params.locale, site.tenant);
  const offsetText = url.searchParams.get('offset') ?? '0';
  if (!locale || !Slug.safeParse(params.slug).success || !/^\d{1,7}$/.test(offsetText)) refuse(404);
  const offset = Number(offsetText);
  if (offset > 100_000 || offset % 9 !== 0) refuse(404);
  const { view, etag } = await loadPersonPage(site, params.slug, locale, offset);
  locals.lang = locale;
  setHeaders({ etag, 'cache-control': PUBLIC_CACHE });
  return view;
};
