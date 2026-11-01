// See @mycel/core ops/well-known.ts; which hosts reach this route is in hooks.server.ts.
import { API_CATALOG_LINK, API_CATALOG_TYPE, apiCatalog, WELL_KNOWN_CACHE } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
  const { PUBLIC_API_URL } = runtime().config;
  if (!PUBLIC_API_URL) return new Response('Not found', { status: 404 });
  return new Response(apiCatalog(PUBLIC_API_URL, locals.site?.tenant.slug), {
    headers: {
      'content-type': API_CATALOG_TYPE,
      'cache-control': WELL_KNOWN_CACHE,
      link: API_CATALOG_LINK,
    },
  });
};
