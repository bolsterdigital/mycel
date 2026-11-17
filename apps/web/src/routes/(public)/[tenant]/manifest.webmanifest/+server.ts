// The site's web app manifest: its name, colours and icon, so a reader who adds the site to
// a home screen gets the site's own mark and colour instead of a screenshot. `display: browser`:
// a site is a website, not an app, and keeps its address bar. A site without a logo names no
// icons. Rejected: `standalone`, which hides the URL a reader may want to share, and a service
// worker, which Mycel does not have (offline reading is not a feature).
import { createHash } from 'node:crypto';
import { PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import { requireSite, sitePath } from '#lib/server/site.js';
import { ICON_SIZES, iconPath, siteBrand, siteTheme } from '#lib/server/public/theme.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  const site = requireSite(locals);
  const [{ logo }, { colors }] = await Promise.all([siteBrand(site), siteTheme(site)]);
  const manifest = {
    name: site.tenant.name,
    short_name: site.tenant.name,
    lang: site.tenant.defaultLocale,
    start_url: sitePath(site, '/'),
    scope: sitePath(site, '/'),
    display: 'browser',
    background_color: colors.light,
    theme_color: colors.light,
    icons: logo.active
      ? ICON_SIZES.filter((size) => size !== 180).map((size) => ({
          src: sitePath(site, iconPath(logo.version, colors.light, size)),
          sizes: `${size}x${size}`,
          type: 'image/png',
          purpose: 'any',
        }))
      : [],
  };
  const body = JSON.stringify(manifest);
  return new Response(body, {
    headers: {
      'content-type': 'application/manifest+json',
      'cache-control': PUBLIC_CACHE,
      'x-content-type-options': 'nosniff',
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    },
  });
};
