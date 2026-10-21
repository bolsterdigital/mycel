// Sets <html lang> per response from the locale the route negotiated (ADR 007), so screen
// readers pronounce the page in the right language. Routes write `event.locals.lang`.
//
// For the operator admin (/admin/*, TODO #7) it also enforces the platform origin (ADR 014
// rule 4: never on a tenant domain) and reads the session cookie into `locals.session`. The
// session says who is logged in; what they may do is the membership, read per request by the
// tenant layout.
import type { Handle } from '@sveltejs/kit/hooks';
import { readSession } from '@mycel/core';
import { SESSION_COOKIE, adminLocale } from '#lib/server/admin.js';
import { onPlatformOrigin } from '#lib/server/admin-paths.js';
import { runtime } from '#lib/server/runtime.js';

const isAdmin = (path: string) => path === '/admin' || path.startsWith('/admin/');

export const handle: Handle = async ({ event, resolve }) => {
  if (isAdmin(event.url.pathname)) {
    const rt = runtime();
    if (!onPlatformOrigin(event.url, rt.config.PUBLIC_BASE_URL))
      return new Response('Not found', { status: 404 });
    event.locals.lang = adminLocale(event.request.headers.get('accept-language'));
    event.locals.session =
      (await readSession(rt.signer, rt.clock, event.cookies.get(SESSION_COOKIE))) ?? undefined;
  }
  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.lang ?? 'en'),
  });
};
