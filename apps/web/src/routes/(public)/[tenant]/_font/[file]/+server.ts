// A site's uploaded font face (MY-302), from the site's own hostname: no request to a third
// party (ADR 009 rule 4). Immutable, because the file name carries the hash of the bytes.
import { anonymousPrincipal } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, siteTenant } from '#lib/server/site.js';
import { siteFontBytes } from '#lib/server/public/fonts/site-fonts.js';
import { shareable } from '#lib/server/http/security-headers.js';
import { refuse } from '#lib/server/http/refuse.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, locals }) => {
  const site = requireSite(locals);
  const bytes = await runtime().uow.run(
    anonymousPrincipal(siteTenant(site), ['content:read']),
    (ctx) => siteFontBytes(ctx, params.file)
  );
  if (!bytes) refuse(404);
  return shareable(
    new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': 'font/woff2',
        'x-content-type-options': 'nosniff',
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  );
};
