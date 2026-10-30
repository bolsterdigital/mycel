// A media variant for the admin preview (lib/server/preview.ts): the site's own delivery
// (`serveMedia`, as a visitor sees it, restricted originals included), but only for an operator
// of this site, and never cached in a shared cache.
import { adminMediaPrincipal } from '#lib/server/admin/admin.js';
import { serveMedia } from '#lib/server/media.js';
import { PREVIEW_HEADERS, previewSite } from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { siteTenant } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

const forbidden = () => new Response(null, { status: 403, headers: PREVIEW_HEADERS });

export const GET: RequestHandler = async ({ params, locals, url }) => {
  if (!(await adminMediaPrincipal(locals, params.tenant))) return forbidden();
  const rt = runtime();
  const tenant = await rt.tenants.findBySlug(params.tenant);
  if (!tenant) return forbidden();
  const res = await serveMedia(
    rt,
    siteTenant(await previewSite(tenant)),
    params.id,
    params.variant,
    url
  );
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(PREVIEW_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
};
