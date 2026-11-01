// The speculation rules a public page's `Speculation-Rules` header points at
// (lib/server/http/speculation.ts). The same for every site, so they hold no tenant data; a browser
// ignores the file unless it has exactly this content type.

import { SPECULATION_RULES, SPECULATION_RULES_TYPE } from '#lib/server/http/speculation.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  new Response(JSON.stringify(SPECULATION_RULES), {
    headers: { 'content-type': SPECULATION_RULES_TYPE, 'cache-control': 'public, max-age=86400' },
  });
