// The reader's side of a site (ADR 016 rule 1, ADR 014): the cookie, the session behind it and
// what the `/reader` routes share. The cookie is host-only (no `Domain`), `HttpOnly`,
// `SameSite=Lax` and `Secure` over HTTPS, with the session's own fixed end; its value names a
// session row and holds no address, supporter or capability. On a tenant hostname its path is
// `/`; in the development path form every site lives on one host, so the path is the site's
// (`/probe`) and the browser does not send one site's cookie to another. The core refuses a
// cookie of another tenant either way, so the path is a courtesy, not the boundary.
//
// It is not the operator cookie: another name, another `typ` in the signed value, and the admin
// never runs on a tenant hostname (hooks.server.ts). Whether the session stands is asked from
// the core on every request (`reader.session.get`): signature, tenant, time, the row and the live
// supporter. Nothing here decides that from the cookie.
//
// Headers: every response of the flow is `no-store` and sends at most the origin as referrer,
// like the double opt-in (public/confirm.ts): the link's token is in a query string.
// Rejected: `SameSite=Strict` (the click in the mail arrives from another site, and the page it
// opens must be able to post with the cookie of an earlier session), and a cookie on the
// platform domain (a reader of one site would be a reader of every site).

import type { Cookies } from '@sveltejs/kit';
import { anonymousPrincipal, readerPrincipal, useCases, type Principal } from '@mycel/core';
import type { UiKey } from '../../../i18n/index.js';
import { NO_STORE } from '../http/http-cache.js';
import { runtime } from '../runtime.js';
import { sitePath, siteTenant, type Site } from '../site.js';

export const READER_COOKIE = 'mycel_reader';

export const READER_HEADERS = {
  'cache-control': NO_STORE,
  'referrer-policy': 'strict-origin',
  'x-robots-tag': 'noindex',
};

/** Where the reader cookie of this site lives: the whole hostname, or the site's path prefix. */
const cookiePath = (site: Site): string => sitePath(site, '') || '/';

export function setReaderCookie(
  cookies: Cookies,
  site: Site,
  url: URL,
  token: string,
  expiresAt: Date
): void {
  cookies.set(READER_COOKIE, token, {
    path: cookiePath(site),
    httpOnly: true,
    sameSite: 'lax',
    secure: url.protocol === 'https:',
    expires: expiresAt,
  });
}

export function clearReaderCookie(cookies: Cookies, site: Site): void {
  cookies.delete(READER_COOKIE, { path: cookiePath(site) });
}

/** A visitor of this site who may read and ask for a link: no client hash, no more. */
export const readerVisitor = (site: Site, ipHash?: string): Principal =>
  anonymousPrincipal(siteTenant(site), ['content:read'], ipHash);

/**
 * The signed-in reader of this request as a principal, or null. A cookie that names no standing
 * session of this site is removed, so a browser stops sending what no longer means anything.
 */
export async function readerOfRequest(cookies: Cookies, site: Site): Promise<Principal | null> {
  const token = cookies.get(READER_COOKIE);
  if (!token) return null;
  const { session } = await runtime().invoker.run(useCases.getReaderSession, readerVisitor(site), {
    token,
  });
  if (!session) {
    clearReaderCookie(cookies, site);
    return null;
  }
  return readerPrincipal(siteTenant(site), session.sessionId);
}

export type SigninOutcome = 'sent' | 'invalid';

const OUTCOME_COPY: Record<SigninOutcome, { title: UiKey; body: UiKey }> = {
  sent: { title: 'reader.sent.title', body: 'reader.sent.body' },
  invalid: { title: 'reader.invalid.title', body: 'reader.invalid.body' },
};

export const signinOutcomeOf = (segment: string): SigninOutcome | undefined =>
  segment === 'sent' || segment === 'invalid' ? segment : undefined;

export const signinOutcomeCopy = (outcome: SigninOutcome) => OUTCOME_COPY[outcome];

export const READER_PATH = '/reader';
export const signinOutcomePath = (site: Site, outcome: SigninOutcome): string =>
  sitePath(site, `${READER_PATH}/signin/${outcome}`);
