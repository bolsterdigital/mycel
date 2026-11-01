// Response security headers of the web app (brief #20c decisions 1 and 2), kept free of the
// runtime so they are unit-testable. `handle` (hooks.server.ts) applies them to every response
// that has no value of its own; the Content-Security-Policy itself comes from the SvelteKit
// `csp` config in vite.config.ts. Admin framing is denied here except for the one live draft
// document route, which may be framed by the same origin.
//
// HSTS has no `includeSubDomains` and no `preload`: a tenant's own apex domain has subdomains we
// do not control, and a preload entry cannot be taken back. Rejected: a second CSP built here
// next to the SvelteKit one, which would drift from it and lose the per-response nonce.
//
// Cross-origin isolation is the opener and resource half only. A page keeps no opener across
// origins and no other origin may load a response as a subresource, except what a site publishes
// for use elsewhere: a mail client or another site shows its images (`shareable`). Rejected:
// Cross-Origin-Embedder-Policy, which nothing here needs and which would make every managed embed
// (ADR 022) opt in.
//
// Fetch Metadata guards the admin alone: a public page has nothing to protect that its own URL
// does not already give away, and its media may be hotlinked. A same-site request is refused
// there too, because a tenant's address can be a sibling of the admin's and runs code the
// operator did not write (ADR 022). Rejected: refusing a request without the header, which would
// lock out older browsers and every API client for no gain, as those send no ambient cookies.

export type ResponseKind = 'public' | 'admin' | 'internal';

export const HSTS = 'max-age=31536000';

/** The headers for one kind of response; `https` is the scheme the request arrived over. */
export function securityHeaders(kind: ResponseKind, https: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': kind === 'admin' ? 'same-origin' : 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...(https ? { 'strict-transport-security': HSTS } : {}),
  };
}

/**
 * Marks a public file as usable from elsewhere; a restricted one (`private`) stays on its origin.
 * Before `applySecurityHeaders`, which leaves a value a route chose.
 */
export function shareable(response: Response): Response {
  if (response.headers.get('cache-control')?.startsWith('public'))
    response.headers.set('cross-origin-resource-policy', 'cross-origin');
  return response;
}

/**
 * What logging out wipes in this browser, for this origin. Not `"cookies"`: that reaches every
 * address under the registered domain, tenant sites included, and the session cookie is removed by
 * name anyway. `"cache"` takes pages kept for the back button, and `"storage"` the tab's records
 * of unsaved input and the sidebar's remembered state.
 */
export const CLEAR_ON_LOGOUT = '"cache", "storage"';

/**
 * A request to the admin that another site made: anything but the visitor following a link or a
 * redirect to a whole page. A request without the header comes from a client without ambient
 * authority or a browser too old to send it.
 */
export function refusedCrossSite(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (!site || site === 'same-origin' || site === 'none') return false;
  const navigation =
    request.headers.get('sec-fetch-mode') === 'navigate' &&
    request.headers.get('sec-fetch-dest') === 'document' &&
    (request.method === 'GET' || request.method === 'HEAD');
  return !navigation;
}

/**
 * Ordinary admin pages may not be framed by anything, their own origin included (clickjacking).
 * Rewrites only the `frame-ancestors` directive of the policy SvelteKit generated, so nonces and
 * every other directive stay as they were; a policy without the directive gets it appended.
 */
export function denyFraming(policy: string): string {
  return frameAncestors(policy, "'none'");
}

/** Only the live draft document may be framed by its own admin origin. */
export function frameAncestors(policy: string, source: "'none'" | "'self'"): string {
  const directives = policy
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .filter((d) => !/^frame-ancestors(\s|$)/i.test(d));
  return [...directives, `frame-ancestors ${source}`].join('; ');
}

/** Sets the headers on a response, leaving any value a route chose itself. */
export function applySecurityHeaders(
  headers: Headers,
  kind: ResponseKind,
  https: boolean,
  liveDraft = false
): void {
  for (const [name, value] of Object.entries(securityHeaders(kind, https)))
    if (!headers.has(name)) headers.set(name, value);
  const policy = headers.get('content-security-policy');
  if (kind === 'admin' && policy)
    headers.set('content-security-policy', frameAncestors(policy, liveDraft ? "'self'" : "'none'"));
}
