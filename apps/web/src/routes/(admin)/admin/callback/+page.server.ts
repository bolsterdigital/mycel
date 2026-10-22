// GET /admin/callback: the IdP's answer. Checks the attempt cookie (single use: it is cleared
// whatever happens), exchanges the code, records the login, and issues a fresh session cookie;
// an earlier session on this browser is replaced, never extended.
import { error, redirect } from '@sveltejs/kit';
import { SESSION_TTL_MS, issueSession } from '@mycel/core';
import {
  SESSION_COOKIE,
  allowLoginAttempt,
  clearCookie,
  cookieOptions,
} from '#lib/server/admin.js';
import { LoginNotConfigured, OIDC_COOKIE, finishLogin } from '#lib/server/oidc.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, cookies, getClientAddress }) => {
  const rt = runtime();
  if (!allowLoginAttempt(rt.signer.hashIp(getClientAddress())))
    error(429, 'Too many login attempts; try again in a few minutes.');
  const attempt = cookies.get(OIDC_COOKIE);
  clearCookie(cookies, OIDC_COOKIE);
  let login;
  try {
    login = await finishLogin(url.search, attempt);
  } catch (e) {
    if (e instanceof LoginNotConfigured) error(503, 'Operator login is not configured.');
    // Mostly a stale or forged callback, so a warning, not an error report.
    rt.log.warn('operator login failed', { error: e instanceof Error ? e.message : String(e) });
    error(400, 'Login failed.');
  }
  if (!login) error(400, 'Login failed.');

  const operator = await rt.identity.login(login.claims);
  const { token } = await issueSession(rt.signer, rt.clock, operator);
  cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS / 1000));
  redirect(303, login.returnTo);
};
