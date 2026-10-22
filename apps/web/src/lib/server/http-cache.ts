// HTTP caching of the public site (brief #8c § 9), applied once to every public response by
// hooks.server.ts, after the route:
//
//   - a 200 with a strong ETag that the request's If-None-Match names becomes a 304 with the
//     same validators, so a revalidation costs no body (the page has rendered, but the bytes
//     are not sent);
//   - a 404 gets `no-store` unless the route said otherwise: an item that is unpublished or
//     restricted now may be public later, and a shared cache must not keep the 404 meanwhile.
//
// The routes set ETag and Cache-Control themselves (they know the revision); this is only the
// conditional half, which a SvelteKit `load` cannot express. Rejected: computing the 304 inside
// `load` by throwing (SvelteKit has no way to end a page load with an empty 304).

/** Content items: one minute fresh, ten more minutes served stale while revalidating. */
export const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=600';
export const NO_STORE = 'no-store';

/** RFC 9110 § 13.1.2: weak comparison for If-None-Match; `*` matches any current representation. */
export function noneMatch(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  return header.split(',').some((tag) => tag.trim() === '*' || opaque(tag) === opaque(etag));
}

export function conditional(request: Request, response: Response): Response {
  if (response.status === 404 && !response.headers.has('cache-control')) {
    response.headers.set('cache-control', NO_STORE);
    return response;
  }
  const etag = response.headers.get('etag');
  if (
    response.status !== 200 ||
    (request.method !== 'GET' && request.method !== 'HEAD') ||
    !etag ||
    etag.startsWith('W/') ||
    !noneMatch(request.headers.get('if-none-match'), etag)
  )
    return response;
  const headers = new Headers(response.headers);
  for (const name of ['content-type', 'content-length', 'content-encoding']) headers.delete(name);
  return new Response(null, { status: 304, headers });
}
