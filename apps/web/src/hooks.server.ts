// Server hooks. `handle` decides, once per request and in this order (brief #14 decision 8):
//
//   1. `/healthz` and `/internal/*`: host-agnostic, no checks (Caddy and the orchestrator speak
//      to the process by its internal name).
//   2. `/admin` and `/admin/*`: platform origin only (ADR 014 rule 4: operator cookies never
//      travel to a tenant site); elsewhere 404. Reads the session cookie into `locals.session`.
//   3. Everything else is a site: resolved from the hostname (`SiteDirectory`), or, on a
//      development host, from the first path segment. The decision table is `decideSite`
//      (lib/server/site.ts); here it only becomes `locals.site`, a 301 or a 404.
//
// Before all that, a request body above 512K is a 413 unless it is the media admin's upload
// (TODO #10b): BODY_SIZE_LIMIT is 26M for that one form (docker/entrypoint.sh), and a public
// signup form has no reason to take more than adapter-node's default did. A chunked body without
// Content-Length is still capped by BODY_SIZE_LIMIT itself.
//
// It also sets <html lang> per response from the locale the route negotiated (ADR 007). `init`
// creates the composition root before the first request so the universal `reroute` hook finds it.

import type { Handle, ServerInit } from '@sveltejs/kit/hooks';
import { readSession } from '@mycel/core';
import { SESSION_COOKIE, adminLocale } from '#lib/server/admin.js';
import { onPlatformOrigin } from '#lib/server/admin-paths.js';
import { runtime } from '#lib/server/runtime.js';
import { decideSite } from '#lib/server/site.js';

const isAdmin = (path: string) => path === '/admin' || path.startsWith('/admin/');
const isInternal = (path: string) => path === '/healthz' || path.startsWith('/internal/');
const SMALL_BODY = 512 * 1024;
const isMediaUpload = (path: string) => /^\/admin\/[^/]+\/media\/?$/.test(path);

export const init: ServerInit = () => {
  runtime();
};

export const handle: Handle = async ({ event, resolve }) => {
  const rt = runtime();
  const path = event.url.pathname;
  const render = () =>
    resolve(event, {
      transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.lang ?? 'en'),
    });

  if (Number(event.request.headers.get('content-length') ?? 0) > SMALL_BODY && !isMediaUpload(path))
    return new Response('Payload too large', { status: 413 });

  if (isInternal(path)) return render();

  if (isAdmin(path)) {
    if (!onPlatformOrigin(event.url, rt.config.PUBLIC_BASE_URL))
      return new Response('Not found', { status: 404 });
    event.locals.lang = adminLocale(event.request.headers.get('accept-language'));
    event.locals.session =
      (await readSession(rt.signer, rt.clock, event.cookies.get(SESSION_COOKIE))) ?? undefined;
    return render();
  }

  const decision = decideSite({
    hostname: event.url.hostname,
    path,
    search: event.url.search,
    found: await rt.sites.resolve(event.url.hostname),
    platform: rt.platform,
  });
  switch (decision.kind) {
    case 'serve':
      event.locals.site = decision.site;
      event.locals.tenant = decision.site.tenant;
      return render();
    case 'redirect':
      return new Response(null, { status: 301, headers: { location: decision.location } });
    case 'path': {
      const tenant = await rt.tenants.findBySlug(decision.slug);
      if (!tenant) return new Response('Not found', { status: 404 });
      // Development only, so one uncached pre-context read per request is fine.
      event.locals.site = {
        tenant,
        form: 'path',
        access: await rt.identity.tenantAccess(tenant.id),
      };
      event.locals.tenant = tenant;
      return render();
    }
    case 'root':
      return render();
    case 'not_found':
      return new Response('Not found', { status: 404 });
  }
};
