// Response security headers of the web app (brief #20c decisions 1 and 2), kept free of the
// runtime so they are unit-testable. `handle` (hooks.server.ts) applies them to every response
// that has no value of its own; the Content-Security-Policy itself comes from the SvelteKit
// `csp` config in vite.config.ts. Admin framing is denied here except for the one live draft
// document route, which may be framed by the same origin.
//
// HSTS has no `includeSubDomains` and no `preload`: a tenant's own apex domain has subdomains we
// do not control, and a preload entry cannot be taken back. Rejected: a second CSP built here
// next to the SvelteKit one, which would drift from it and lose the per-response nonce.

export type ResponseKind = 'public' | 'admin' | 'internal';

export const HSTS = 'max-age=31536000';

/** The headers for one kind of response; `https` is the scheme the request arrived over. */
export function securityHeaders(kind: ResponseKind, https: boolean): Record<string, string> {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': kind === 'admin' ? 'same-origin' : 'strict-origin-when-cross-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    ...(https ? { 'strict-transport-security': HSTS } : {}),
  };
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
