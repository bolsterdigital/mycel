// Shared plumbing of the operator admin: cookie flags, the login rate limit, and the admin's
// time zone. The session itself is decided in core (`issueSession`, `readSession`); the tenant and
// capabilities of a request come from the membership, never from the cookie.

import {
  DEFAULT_TIME_ZONE,
  can,
  operatorPrincipal,
  useCases,
  type OperatorSession,
  type Principal,
  type TenantInfo,
} from '@mycel/core';
import { error, redirect, type Cookies } from '@sveltejs/kit';
import { adminCookieOptions, loginLimiter } from './admin-paths.js';
import { runtime } from '../runtime.js';

export const SESSION_COOKIE = 'mycel_session';

/** The admin's cookie flags for this platform origin (`adminCookieOptions`). */
export const cookieOptions = (maxAgeSeconds: number) =>
  adminCookieOptions(runtime().config.PUBLIC_BASE_URL, maxAgeSeconds);

export function clearCookie(cookies: Cookies, name: string): void {
  cookies.delete(name, { path: '/admin' });
}

/** Login starts and callbacks per client address: 20 per 10 minutes, shared by every process. */
export const allowLoginAttempt = (key: string): Promise<boolean> =>
  loginLimiter(runtime().identity)(key);

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

/**
 * The operator's principal for the tenant in an /admin/[tenant]/... file route, or null: no
 * session, an unknown tenant or no membership all end as a 403 in `serveAdminMedia`
 * (lib/server/media.ts) and as a 404 in `serveExportDownload` (lib/server/admin/export-download.ts).
 */
export async function adminMediaPrincipal(
  locals: App.Locals,
  slug: string
): Promise<Principal | null> {
  if (!locals.session) return null;
  const rt = runtime();
  const tenant = await rt.tenants.findBySlug(slug);
  return tenant ? operatorPrincipal(rt.identity, locals.session, tenant.id) : null;
}

const zones = new WeakMap<App.Locals, Promise<{ zone: string; site: string }>>();

/**
 * The zone the admin shows and reads times in (#88), decided here only: the operator's own
 * (`locals.preferences`), else the site's general setting, else Europe/Amsterdam. Also sets
 * `locals.timeZone`. Once per request: layout, page and action share the answer. `site` is the
 * site's zone, so a page can name the zone only where the operator's differs from it.
 *
 * Call after `requireTenantPrincipal`: without `locals.principal` there is no site to ask. A
 * member who may not read content gets the default for the site's part; the time zone of a site
 * is no secret, but `site.general.get` asks `content:read` like the theme does.
 */
export function adminTimeZone(locals: App.Locals): Promise<{ zone: string; site: string }> {
  let found = zones.get(locals);
  if (!found) {
    found = (async () => {
      const principal = locals.principal;
      const site =
        principal && can(principal, 'content:read')
          ? (await runtime().invoker.run(useCases.getSiteGeneral, principal, {})).value.timeZone
          : DEFAULT_TIME_ZONE;
      const zone = locals.preferences?.timeZone ?? site;
      locals.timeZone = zone;
      return { zone, site };
    })();
    zones.set(locals, found);
  }
  return found;
}
