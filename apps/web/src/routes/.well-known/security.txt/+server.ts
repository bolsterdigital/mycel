// See @mycel/core ops/well-known.ts; which hosts reach this route is in hooks.server.ts.
import { SECURITY_TXT_TYPE, securityTxt, WELL_KNOWN_CACHE } from '@mycel/core';
import { runtime } from '#lib/server/runtime.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
  const { config, clock } = runtime();
  if (!config.SECURITY_CONTACT) return new Response('Not found', { status: 404 });
  return new Response(securityTxt(config.SECURITY_CONTACT, clock.now()), {
    headers: { 'content-type': SECURITY_TXT_TYPE, 'cache-control': WELL_KNOWN_CACHE },
  });
};
