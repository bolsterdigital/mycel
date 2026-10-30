// GET /admin/login?return=<path>: remember this attempt in a signed cookie and send the browser
// to the IdP. Rate limited per client address; 503 when no issuer is configured, so a site
// without operator login still serves its public pages.
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
