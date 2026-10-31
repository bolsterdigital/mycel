// GET /admin/login?return=<path>: a page that says where you are, why you are here and where
// the button takes you (brief admin-entry § 1-2). Its button links back to this route with
// `start`, which remembers the attempt in a signed cookie and sends the browser to the IdP:
// that part is unchanged. Rate limited per client address (only the start counts); 503 when no
// issuer is configured, so a site without operator login still serves its public pages.
// Rejected: an automatic redirect (the operator never learns why they had to log in, or with
// which account) and a form (CSP `form-action 'self'` blocks the redirect to the IdP after it).
import { error, redirect } from '@sveltejs/kit';
import { allowLoginAttempt, cookieOptions } from '#lib/server/admin/admin.js';
import { safeReturn } from '#lib/server/admin/admin-paths.js';
import {
  LoginNotConfigured,
  OIDC_COOKIE,
  OIDC_COOKIE_TTL_MS,
  startLogin,
} from '#lib/server/admin/oidc.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, cookies, getClientAddress }) => {
  if (!url.searchParams.has('start')) return landing(url);
  if (!(await allowLoginAttempt(runtime().signer.hashIp(getClientAddress()))))
    error(429, 'Too many login attempts; try again in a few minutes.');
  let started;
  try {
    started = await startLogin(safeReturn(url.searchParams.get('return')));
  } catch (e) {
    if (e instanceof LoginNotConfigured) error(503, 'Operator login is not configured.');
    throw e;
  }
  cookies.set(OIDC_COOKIE, started.cookie, cookieOptions(OIDC_COOKIE_TTL_MS / 1000));
  // The authorization endpoint comes from the issuer's discovery document, never from the request.
  redirect(303, started.url.href, { external: [started.url.origin] });
};

/** The page before the IdP: the path to return to, whether one was asked for, and the IdP host. */
function landing(url: URL) {
  const issuer = runtime().config.OIDC_ISSUER;
  const returnTo = safeReturn(url.searchParams.get('return'));
  return {
    returnTo,
    start: `/admin/login?${new URLSearchParams({ return: returnTo, start: '1' })}`,
    sentHere: url.searchParams.has('return'),
    idp: issuer ? new URL(issuer).host : null,
  };
}
