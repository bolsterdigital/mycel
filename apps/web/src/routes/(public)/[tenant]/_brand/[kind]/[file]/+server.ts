// The only public brand bytes are the current safe derivative and current validated font.
// Rejected: serving an uploaded SVG or an older asset from a permanent blob URL.
import { anonymousPrincipal } from '@mycel/core';
import { error } from '@sveltejs/kit';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, siteTenant } from '#lib/server/site.js';
import { brandPath, siteBrand } from '#lib/server/theme.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
  const site = requireSite(locals);
  const kind = params.kind;
  if (kind !== 'logo' && kind !== 'font') error(404, 'Not found');
  const state = (await siteBrand(site))[kind];
  if (!state.active || params.file !== brandPath(kind, state.version).split('/').at(-1))
    error(404, 'Not found');
  const asset = await runtime().uow.run(
    anonymousPrincipal(siteTenant(site), ['content:read']),
    (ctx) => ctx.brandAssets.get(kind)
  );
  if (!asset.asset || asset.version !== state.version) error(404, 'Not found');
  return new Response(new Uint8Array(asset.asset.bytes), {
    headers: {
      'content-type': asset.asset.contentType,
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
};
