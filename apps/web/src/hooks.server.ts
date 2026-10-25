// Server hooks. `handle` decides, once per request and in this order (brief #14 decision 8):
//
//   1. `/healthz`, `/readyz` and `/internal/*`: host-agnostic, no checks (Caddy and the
//      orchestrator speak to the process by its internal name).
//   2. `/admin` and `/admin/*`: platform origin only (ADR 014 rule 4: operator cookies never
//      travel to a tenant site); elsewhere 404. Reads the session cookie into `locals.session`.
//   3. Everything else is a site: resolved from the hostname (`SiteDirectory`), or, on a
//      development host, from the first path segment. The decision table is `decideSite`
//      (lib/server/site.ts); here it only becomes `locals.site`, a 301 or a 404.
//
// Before all that, a request body above 512K is a 413 unless it is the media admin's upload
// (TODO #10b): BODY_SIZE_LIMIT is 26M for that one form (docker/entrypoint.sh), and a public
// signup form has no reason to take more than adapter-node's default did. Actual bytes are
// counted as well as Content-Length, including chunked bodies and other media actions.
//
// It also sets <html lang> per response from the locale the route negotiated (ADR 007). `init`
// creates the composition root before the first request so the universal `reroute` hook finds it.
//
// Every request runs in a log context (TODO #17a): a request id (a valid incoming `X-Request-Id`
// or a fresh one, echoed in the response), the tenant once the site is known, and one access
// line with the route id, never the path with its query. `handleError` reports only `unknown`
// errors (thrown by our code): an `error(...)` from a route or a framework 404 is no failure.
//
// After `route`, every response gets the security headers of its kind (TODO #20c,
// lib/server/security-headers.ts): HSTS only when the request came over HTTPS, which with
// MYCEL_TRUST_PROXY=1 follows Caddy's X-Forwarded-Proto. The CSP is SvelteKit's (vite.config.ts);
// on the admin its frame-ancestors is tightened to 'none', except the live draft route ('self').
//
// Public responses then pass `conditional` (brief #8c § 9, lib/server/http-cache.ts): a matching
// If-None-Match on a page with a strong ETag becomes a 304, and a 404 gets `no-store`.

import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { readSession } from '@mycel/core';
import { requestIdFrom, runWithContext, setContext } from '@mycel/observability';
import { SESSION_COOKIE, adminLocale } from '#lib/server/admin.js';
import { onPlatformOrigin } from '#lib/server/admin-paths.js';
import { runtime } from '#lib/server/runtime.js';
import { decideSite } from '#lib/server/site.js';
import { bodyLimit, boundedBody } from '#lib/server/body-limit.js';
import { applySecurityHeaders, type ResponseKind } from '#lib/server/security-headers.js';
import { conditional } from '#lib/server/http-cache.js';

const isAdmin = (path: string) => path === '/admin' || path.startsWith('/admin/');
const isProbe = (path: string) => path === '/healthz' || path === '/readyz';
const isInternal = (path: string) => isProbe(path) || path.startsWith('/internal/');
const kindOf = (path: string): ResponseKind =>
  isInternal(path) ? 'internal' : isAdmin(path) ? 'admin' : 'public';

export const init: ServerInit = () => {
  runtime();
};

export const handle: Handle = async (input) => {
  const rt = runtime();
  const { event } = input;
  const requestId = requestIdFrom(event.request.headers.get('x-request-id'), rt.http.newRequestId);
  const started = performance.now();
  return runWithContext({ requestId }, async () => {
    let response = await route(input);
    try {
      response.headers.set('x-request-id', requestId);
    } catch {
      // Immutable headers (`Response.redirect`, a proxied fetch): a copy takes them.
      response = new Response(response.body, response);
      response.headers.set('x-request-id', requestId);
    }
    const kind = kindOf(event.url.pathname);
    if (kind === 'public') response = conditional(event.request, response);
    const liveDraft = /^\/admin\/[^/]+\/preview\/draft$/.test(event.url.pathname);
    if (liveDraft) {
      response.headers.set('cache-control', 'private, no-store');
      response.headers.set('x-robots-tag', 'noindex');
    }
    applySecurityHeaders(response.headers, kind, event.url.protocol === 'https:', liveDraft);
    rt.log[isProbe(event.url.pathname) ? 'debug' : 'info']('request', {
      method: event.request.method,
      route: event.route.id ?? 'unmatched',
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    });
    return response;
  });
};

export const handleError: HandleServerError = ({ kind, error }) => {
  if (kind !== 'unknown') return;
  runtime().errors.capture(error);
};

const route: Handle = async ({ event, resolve }) => {
  const rt = runtime();
  const path = event.url.pathname;
  const request = await boundedBody(event.request, bodyLimit(event.request, event.url));
  if (!request) return new Response('Payload too large', { status: 413 });
  const render = () =>
    resolve(
      { ...event, request },
      {
        transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.lang ?? 'en'),
      }
    );

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
      setContext({ tenantId: decision.site.tenant.id });
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
      setContext({ tenantId: tenant.id });
      return render();
    }
    case 'root':
      return render();
    case 'not_found':
      return new Response('Not found', { status: 404 });
  }
};
