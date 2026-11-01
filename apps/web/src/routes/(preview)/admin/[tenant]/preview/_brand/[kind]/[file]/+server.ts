// Preview assets use the same safe bytes as public delivery but require site membership.
import { error } from '@sveltejs/kit';
import { requireTenantPrincipal } from '#lib/server/admin/admin.js';
import { NO_STORE } from '#lib/server/http/http-cache.js';
import { PREVIEW_HEADERS } from '#lib/server/preview.js';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals, url }) => {
  const { principal } = await requireTenantPrincipal(locals, url, params.tenant);
  const kind = params.kind;
  if (kind !== 'logo' && kind !== 'font') error(404, 'Not found');
  const state = await runtime().uow.run(principal, (ctx) => ctx.brandAssets.get(kind));
  if (!state.asset || params.file !== `${state.version}.${kind === 'logo' ? 'webp' : 'woff2'}`)
    error(404, 'Not found');
  return new Response(new Uint8Array(state.asset.bytes), {
    headers: {
      ...PREVIEW_HEADERS,
      'content-type': state.asset.contentType,
      'x-content-type-options': 'nosniff',
      'cache-control': NO_STORE,
    },
  });
};
