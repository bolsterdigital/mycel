// The site's theme stylesheet for the admin preview (lib/server/preview.ts), the same CSS as the
// site's `/_theme/<hash>.css`. Only an operator of this site gets it; a stale valid hash redirects
// without caching, while a malformed hash is a 404.
import { error } from '@sveltejs/kit';
import { adminMediaPrincipal } from '#lib/server/admin.js';
import { PREVIEW_HEADERS, previewSite } from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { siteTheme, themePath } from '#lib/server/theme.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!(await adminMediaPrincipal(locals, params.tenant))) error(403, 'Forbidden');
  const tenant = await runtime().tenants.findBySlug(params.tenant);
  if (!tenant) error(404, 'Not found');
  const theme = await siteTheme(await previewSite(tenant));
  if (!/^[0-9a-f]{16}\.css$/.test(params.file)) error(404, 'Not found');
  if (params.file !== `${theme.hash}.css`)
    return new Response(null, {
      status: 302,
      headers: {
        location: `/admin/${params.tenant}/preview${themePath(theme.hash)}`,
        ...PREVIEW_HEADERS,
      },
    });
  return new Response(theme.css, {
    headers: { 'content-type': 'text/css; charset=utf-8', ...PREVIEW_HEADERS },
  });
};
