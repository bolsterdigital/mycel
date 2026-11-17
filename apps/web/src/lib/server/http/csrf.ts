// The CSRF origin check of every form post, run by hooks.server.ts in place of SvelteKit's own
// (`kit.csrf.trustedOrigins: ['*']` in vite.config.ts turns that one off). Same rule, same answer:
// a POST, PUT, PATCH or DELETE with a form content type (or none) whose `Origin` is not this
// origin is a 403 before any action runs. It differs in one route only: the `List-Unsubscribe`
// address of a newsletter (RFC 8058), which a mail provider POSTs to from its own servers without
// an Origin of this site. That route's token is its whole authority and can only unsubscribe the
// person it was sent to, so a forged request gains nothing a link click would not.
//
// Rejected: an exempt origin list (`trustedOrigins`), which cannot admit a request without an
// Origin; the provider's POST on the API hostname, whose GET then is no page for the person
// whose client opens the address in a browser; and rewriting the request in a node server around
// the adapter's handler, a second entry point that the e2e build would not run.
//
// SvelteKit skips the check in development, and so does this one: the dev server's origin is not
// the one a form on a tenant hostname posts from. The e2e suite runs a build.

/** The one route exempt from the origin check, by SvelteKit route id. */
export const ONE_CLICK_ROUTE = '/(public)/[tenant]/unsubscribe/one-click';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The content types a browser form can send cross-site without a preflight (and SvelteKit's own). */
const FORM_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
  'application/x-sveltekit-formdata',
];

const isFormType = (header: string | null) =>
  !header || FORM_TYPES.includes(header.split(';', 1)[0]!.trim().toLowerCase());

/** True when the request is a cross-site form submission to anything but the exempt route. */
export function csrfForbidden(request: Request, selfOrigin: string, routeId: string | null) {
  if (routeId === ONE_CLICK_ROUTE) return false;
  return (
    MUTATING.has(request.method) &&
    isFormType(request.headers.get('content-type')) &&
    request.headers.get('origin') !== selfOrigin
  );
}

/** SvelteKit's answer to the same request, word for word, so a client sees no difference. */
export function csrfRefusal(request: Request): Response {
  const message = `Cross-site ${request.method} form submissions are forbidden`;
  return request.headers.get('accept') === 'application/json'
    ? Response.json({ message }, { status: 403 })
    : new Response(message, { status: 403, headers: { 'content-type': 'text/plain' } });
}
