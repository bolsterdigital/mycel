// `/media/<id>/<variant>` on every site (TODO #10): a media variant from the BlobStore, with the
// headers of lib/server/media.ts. The tenant is `locals.site` (hooks.server.ts), so on a tenant
// hostname the reroute hook's slug and in development the path's slug both end up here, and
// `params.tenant` is never read (ADR 014). HEAD is answered from GET by SvelteKit.
import { runtime } from '#lib/server/runtime.js';
import { serveMedia } from '#lib/server/media.js';
import { requireSite, siteTenant } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url, request }) => {
  const rt = runtime();
  const tenant = siteTenant(requireSite(locals));
  return serveMedia(
    rt,
    tenant,
    params.id,
    params.variant,
    url,
    request.headers.get('if-none-match')
  );
};
