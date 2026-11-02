// GET /admin/callback: the IdP's answer. Checks the attempt cookie (single use: it is cleared
// whatever happens), exchanges the code, records the login, and issues a fresh session cookie;
// an earlier session on this browser is replaced, never extended.
import { redirect } from '@sveltejs/kit';
import { SESSION_TTL_MS, errorFields, issueSession } from '@mycel/core';
import {
  SESSION_COOKIE,
  allowLoginAttempt,
  clearCookie,
  cookieOptions,
} from '#lib/server/admin/admin.js';
import { LoginNotConfigured, OIDC_COOKIE, finishLogin } from '#lib/server/admin/oidc.js';
import { runtime } from '#lib/server/runtime.js';
import type { PageServerLoad } from './$types';
import { refuse } from '#lib/server/http/refuse.js';

export const load: PageServerLoad = async ({ url, cookies, getClientAddress }) => {
  const rt = runtime();
  if (!(await allowLoginAttempt(rt.signer.hashIp(getClientAddress())))) refuse(429);
  const attempt = cookies.get(OIDC_COOKIE);
  clearCookie(cookies, OIDC_COOKIE);
  let login;
  try {
    login = await finishLogin(url.search, attempt);
  } catch (e) {
    if (e instanceof LoginNotConfigured) refuse(503);
    // Mostly a stale or forged callback, so a warning, not an error report.
    rt.log.warn('operator login failed', errorFields(e));
    refuse(400);
  }
  if (!login) refuse(400);

  const operator = await rt.identity.login(login.claims);
  const { token } = await issueSession(rt.signer, rt.clock, operator);
  cookies.set(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS / 1000));
  redirect(303, login.returnTo);
};
