// The theme stylesheet (brief #8c § 3): `/_theme/<hash>.css`, the hash of the CSS itself, so the
// response is immutable and a changed theme is simply a new URL the layout links. Any other hash
// is a 404 rather than the current CSS, so a stale URL never caches a theme under the wrong key.
// `_theme` cannot collide with a page: a `Slug` starts with `[a-z0-9]`.

import { error } from '@sveltejs/kit';
import { requireSite } from '#lib/server/site.js';
import { siteTheme } from '#lib/server/theme.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
  const theme = await siteTheme(requireSite(locals));
  if (params.file !== `${theme.hash}.css`) error(404, 'Not found');
  return new Response(theme.css, {
    headers: {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
