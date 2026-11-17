// HTTP caching of the public site (brief #8c § 9), applied once to every public response by
// hooks.server.ts, after the route:
//
//   - a 200 with a strong ETag that the request's If-None-Match names becomes a 304 with the
//     same validators, so a revalidation costs no body (the page has rendered, but the bytes
//     are not sent);
//   - a 404 gets `no-store` unless the route said otherwise: an item that is unpublished or
//     restricted now may be public later, and a shared cache must not keep the 404 meanwhile;
//   - a `no-store` response carries no validator, `private, no-store` included. SvelteKit adds
//     an ETag of its own to a page the route gave none, and a form page (#30A) must never be
//     revalidated into a 304 that keeps an old timing token, not even by `If-None-Match: *`; a
//     reader's page (ADR 018 rule 8) must never become a 304 at all.
//
// The routes set ETag and Cache-Control themselves (they know the revision); this is only the
// conditional half, which a SvelteKit `load` cannot express. SvelteKit's own `respond` already
// answers a 304 when If-None-Match equals the ETag exactly (one tag, after stripping `W/`); this
// adds the RFC 9110 list form and `*`, and is the one place for the 404 policy, so the e2e suite
// proves the behaviour against this module rather than against a framework default. Rejected:
// computing the 304 inside `load` by throwing (SvelteKit has no way to end a page load with an
// empty 304). The If-None-Match rule itself is the API's (`@mycel/api/conditional`), so the site
// and the JSON read route of the same content cannot disagree on it.

import { ifNoneMatch } from '@mycel/api/conditional';

/** Content items: one minute fresh, ten more minutes served stale while revalidating. */
export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=600';
export const NO_STORE = 'no-store';
/** What only this signed-in person or signed link may see; no cache may keep it either. */
export const PRIVATE_NO_STORE = 'private, no-store';

/**
 * The caching headers of a content item's answer, for the HTML and the Markdown alike. A
 * personal answer is the reader's alone; a restricted item's public teaser is cacheable, but
 * every answer at a restricted address varies on the cookie, so a cache never hands the teaser
 * to a reader or a reader's page to a visitor.
 */
export function itemCacheHeaders(view: {
  restricted: boolean;
  personal: boolean;
  etag: string | null;
}): Record<string, string> {
  const vary: Record<string, string> = view.restricted ? { vary: 'Cookie' } : {};
  if (view.personal) return { 'cache-control': PRIVATE_NO_STORE, ...vary };
  if (view.etag) return { etag: view.etag, 'cache-control': PUBLIC_CACHE, ...vary };
  return { 'cache-control': NO_STORE, ...vary };
}

export function conditional(request: Request, response: Response): Response {
  if (response.status === 404 && !response.headers.has('cache-control')) {
    response.headers.set('cache-control', NO_STORE);
    return response;
  }
  if (/(^|,)\s*no-store\s*(,|$)/i.test(response.headers.get('cache-control') ?? '')) {
    response.headers.delete('etag');
    return response;
  }
  const etag = response.headers.get('etag');
  if (
    response.status !== 200 ||
    (request.method !== 'GET' && request.method !== 'HEAD') ||
    !etag ||
    etag.startsWith('W/') ||
    !ifNoneMatch(request.headers.get('if-none-match'), etag)
  )
    return response;
  const headers = new Headers(response.headers);
  for (const name of ['content-type', 'content-length', 'content-encoding']) headers.delete(name);
  return new Response(null, { status: 304, headers });
}
