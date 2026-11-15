// The site's robots.txt: the absolute URL of its sitemap on the primary hostname
// (ADR 014 rule 6, never the request's Host) and the paths no crawler needs. `/admin` never runs
// on a tenant hostname (ADR 014), but on the development path form it sits beside the site, so it
// is named anyway; the site's own technical routes carry the site's prefix (`sitePath`). Media
// stay crawlable: an image search may show a public image. So do `/_theme` (the stylesheet) and
// `/_brand` (logo and font): a crawler that renders the page needs them, and blocking them shows
// it every page unstyled. Rejected: a per-tenant editable file (a typo can hide a whole site;
// `seo.noindex` is the per-item switch) and listing restricted URLs here (robots.txt is public
// and would map them).
import { createHash } from 'node:crypto';
import { PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import { requireSite, sitePath, siteUrls } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  const site = requireSite(locals);
  const absolute = await siteUrls(site);
  const internal = ['/_speculation.json', '/confirm'];
  const body = [
    'User-agent: *',
    'Disallow: /admin',
    ...internal.map((path) => `Disallow: ${sitePath(site, path)}`),
    '',
    `Sitemap: ${absolute('/sitemap.xml')}`,
    '',
  ].join('\n');
  return new Response(body, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': PUBLIC_CACHE,
      'x-content-type-options': 'nosniff',
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    },
  });
};
