// The theme stylesheet (brief #8c § 3): `/_theme/<hash>.css`, the hash of the CSS itself, so the
// response is immutable and a changed theme is simply a new URL the layout links. A former valid
// hash redirects without caching; malformed hashes are 404. Never serve new CSS under an old key.
// `_theme` cannot collide with a page: a `Slug` starts with `[a-z0-9]`.

import { error } from '@sveltejs/kit';
import { NO_STORE } from '#lib/server/http/http-cache.js';
import { requireSite, sitePath } from '#lib/server/site.js';
import { siteTheme, themePath } from '#lib/server/theme.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
  const site = requireSite(locals);
  const theme = await siteTheme(site);
  if (!/^[0-9a-f]{16}\.css$/.test(params.file)) error(404, 'Not found');
  // Cached HTML may still reference the preceding immutable hash after an editor saves a theme.
  // Redirect to the new hash without caching the redirect; never serve new CSS under an old hash.
  if (params.file !== `${theme.hash}.css`)
    return new Response(null, {
      status: 302,
      headers: { location: sitePath(site, themePath(theme.hash)), 'cache-control': NO_STORE },
    });
  return new Response(theme.css, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
