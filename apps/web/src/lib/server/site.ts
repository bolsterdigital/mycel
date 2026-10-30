// Which site a request is for (ADR 014, brief #14 decision 8), as a pure decision over what the
// directory answered, so the table below is unit-testable without a server:
//
//   hostname known, primary                       -> serve that tenant
//   hostname known, verified (or platform), other -> 301 to the primary, path and query kept
//   hostname known, unverified custom             -> 404 (nothing is served before verification)
//   hostname unknown, a development host          -> path form: `/{tenant}/...` names the tenant
//   anything else                                 -> 404
//
// `/healthz` and `/internal/*` never get here (host-agnostic), nor does `/admin` (platform
// origin only, hooks.server.ts). Rejected: serving an unverified custom hostname "because DNS
// already points here": that is exactly the state in which a stranger's DNS could point at us.

import { error } from '@sveltejs/kit';
import {
  anonymousPrincipal,
  siteUrl,
  type PlatformConfig,
  type Principal,
  type ResolvedSite,
  type TenantAccess,
  type TenantInfo,
  type TenantRef,
} from '@mycel/core';
import { runtime } from './runtime.js';

/** The site of the current request, on `locals.site` (and its tenant on `locals.tenant`). */
export interface Site {
  tenant: TenantInfo;
  /** `hostname`: served on one of the tenant's hostnames; `path`: the development path form. */
  form: 'hostname' | 'path';
  /** Known when the request came in on a hostname; the path form looks it up when needed. */
  primaryHostname?: string | null;
  /** Entitlements and status, loaded with the site before any tenant context (ADR 015 rule 3). */
  access: TenantAccess;
}

/** What a visitor's Principal is built from: the tenant plus its entitlements and status. */
export const siteTenant = (site: Site): Exclude<TenantRef, string> => ({
  id: site.tenant.id,
  ...site.access,
});

export type SiteDecision =
  | { kind: 'serve'; site: Site }
  | { kind: 'redirect'; location: string }
  | { kind: 'path'; slug: string }
  | { kind: 'root' }
  | { kind: 'not_found' };

export function decideSite(input: {
  hostname: string;
  path: string;
  search: string;
  found: ResolvedSite | null;
  platform: Pick<PlatformConfig, 'devHosts' | 'platformOrigin' | 'siteUrlMode'>;
}): SiteDecision {
  const { found, platform } = input;
  if (found) {
    const h = found.hostname;
    const live = h.kind === 'platform' || h.verifiedAt !== null;
    if (!live) return { kind: 'not_found' };
    if (h.primary)
      return {
        kind: 'serve',
        site: {
          tenant: found.tenant,
          form: 'hostname',
          primaryHostname: h.hostname,
          access: found.access,
        },
      };
    return {
      kind: 'redirect',
      location: siteUrl(
        { slug: found.tenant.slug, primaryHostname: found.primaryHostname },
        platform,
        `${input.path}${input.search}`
      ),
    };
  }
  if (!platform.devHosts.includes(input.hostname)) return { kind: 'not_found' };
  const slug = input.path.split('/')[1] ?? '';
  return slug ? { kind: 'path', slug } : { kind: 'root' };
}

/**
 * The path of a site-relative link in the current request's form: `/signup/thanks` on a
 * hostname, `/probe/signup/thanks` in the path form. Relative, so a visitor stays where they
 * came in; absolute URLs are `siteUrl`'s business (ADR 014 rule 6).
 */
export const sitePath = (site: Site, path: string): string =>
  site.form === 'hostname' ? path : `/${site.tenant.slug}${path}`;

/**
 * The builder of the site's absolute URLs, on its primary hostname, through the one builder
 * (ADR 014 rule 6). The primary hostname is looked up once, so a page with a canonical link and
 * one `hreflang` per locale costs at most one read.
 */
export async function siteUrls(site: Site): Promise<(path: string) => string> {
  const rt = runtime();
  const primaryHostname =
    site.primaryHostname !== undefined
      ? site.primaryHostname
      : ((
          await rt.uow.run(anonymousPrincipal(siteTenant(site), []), (ctx) =>
            ctx.hostnames.primary()
          )
        )?.hostname ?? null);
  return (path) => rt.siteUrl({ slug: site.tenant.slug, primaryHostname }, path);
}

/**
 * The builder of a site's absolute URLs from the admin, where there is no site request: the
 * operator's principal reads the primary hostname under its own tenant ("view on the site", #66
 * PR 2).
 */
export async function adminSiteUrls(
  principal: Principal,
  slug: string
): Promise<(path: string) => string> {
  const rt = runtime();
  const primaryHostname =
    (await rt.uow.run(principal, (ctx) => ctx.hostnames.primary()))?.hostname ?? null;
  return (path) => rt.siteUrl({ slug, primaryHostname }, path);
}

/** One absolute URL of the site; `siteUrls` when you need several. */
export async function absoluteSiteUrl(site: Site, path: string): Promise<string> {
  return (await siteUrls(site))(path);
}

/** The site of a request as the hooks established it; a route without one is a 404. */
export function requireSite(locals: App.Locals): Site {
  if (!locals.site) error(404, 'Not found');
  return locals.site;
}
