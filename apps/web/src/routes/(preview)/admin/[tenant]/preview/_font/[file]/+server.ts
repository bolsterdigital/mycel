// The preview's copy of the public font route (MY-302): the same bytes, for members only and
// never cached, like the preview's brand assets.
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { NO_STORE } from '#lib/server/http/http-cache.js';
import { PREVIEW_HEADERS } from '#lib/server/content/preview.js';
import { runtime } from '#lib/server/runtime.js';
import { siteFontBytes } from '#lib/server/public/fonts/site-fonts.js';
import { refuse } from '#lib/server/http/refuse.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const bytes = await runtime().uow.run(principal, (ctx) => siteFontBytes(ctx, params.file));
  if (!bytes) refuse(404);
  return new Response(new Uint8Array(bytes), {
    headers: {
      ...PREVIEW_HEADERS,
      'content-type': 'font/woff2',
      'x-content-type-options': 'nosniff',
      'cache-control': NO_STORE,
    },
  });
};
