// Shared plumbing of the operator admin: cookie flags, the login rate limit, and the admin's own
// locale. The session itself is decided in core (`issueSession`, `readSession`); the tenant and
// capabilities of a request come from the membership, never from the cookie.

import {
  negotiateLocale,
  operatorPrincipal,
  type OperatorSession,
  type Principal,
  type TenantInfo,
} from '@mycel/core';
import { error, redirect, type Cookies } from '@sveltejs/kit';
import { windowLimiter } from './admin-paths.js';
import { runtime } from './runtime.js';

export const SESSION_COOKIE = 'mycel_session';

/** HttpOnly, SameSite=Lax, only under /admin, Secure whenever the platform origin is https. */
export function cookieOptions(maxAgeSeconds: number) {
  return {
    path: '/admin',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: runtime().config.PUBLIC_BASE_URL.startsWith('https://'),
    maxAge: maxAgeSeconds,
  };
}

export function clearCookie(cookies: Cookies, name: string): void {
  cookies.delete(name, { path: '/admin' });
}

/** Login starts and callbacks per client address: 20 per 10 minutes, in this process. */
export const allowLoginAttempt = windowLimiter(20, 10 * 60 * 1000);

export const ADMIN_LOCALES = ['nl', 'en'] as const;

/** The admin speaks the operator's language when it has it (ADR 007), English otherwise. */
export const adminLocale = (acceptLanguage: string | null): string =>
  negotiateLocale(acceptLanguage, ADMIN_LOCALES, 'en');

/** The logged-in operator, or a redirect to the login that returns here. */
export function requireSession(locals: App.Locals, url: URL): OperatorSession {
  if (!locals.session)
    redirect(303, `/admin/login?return=${encodeURIComponent(url.pathname + url.search)}`);
  return locals.session;
}

/**
 * The tenant in an /admin/[tenant] URL and the operator's principal for it, from the membership
 * (ADR 002 rule 3): read per request, never from the cookie, so a revoked membership stops
 * working at once. 403 for a non-member, 404 for an unknown tenant.
 */
export async function requireTenantPrincipal(
  locals: App.Locals,
  url: URL,
  slug: string
): Promise<{ tenant: TenantInfo; principal: Principal; session: OperatorSession }> {
  const session = requireSession(locals, url);
  const rt = runtime();
  const tenant = await rt.tenants.findBySlug(slug);
  if (!tenant) error(404, 'Not found');
  const principal = await operatorPrincipal(rt.identity, session, tenant.id);
  if (!principal) error(403, 'Not a member of this site');
  locals.principal = principal;
  return { tenant, principal, session };
}
