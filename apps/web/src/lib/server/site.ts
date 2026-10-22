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
  type ResolvedSite,
  type TenantInfo,
} from '@mycel/core';
import { runtime } from './runtime.js';

/** The site of the current request, on `locals.site` (and its tenant on `locals.tenant`). */
export interface Site {
  tenant: TenantInfo;
  /** `hostname`: served on one of the tenant's hostnames; `path`: the development path form. */
  form: 'hostname' | 'path';
  /** Known when the request came in on a hostname; the path form looks it up when needed. */
  primaryHostname?: string | null;
}

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
        site: { tenant: found.tenant, form: 'hostname', primaryHostname: h.hostname },
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

/** An absolute URL of the site, on its primary hostname, through the one builder (ADR 014 rule 6). */
export async function absoluteSiteUrl(site: Site, path: string): Promise<string> {
  const rt = runtime();
  const primaryHostname =
    site.primaryHostname !== undefined
      ? site.primaryHostname
      : ((
          await rt.uow.run(anonymousPrincipal(site.tenant.id, []), (ctx) => ctx.hostnames.primary())
        )?.hostname ?? null);
  return rt.siteUrl({ slug: site.tenant.slug, primaryHostname }, path);
}

/** The site of a request as the hooks established it; a route without one is a 404. */
export function requireSite(locals: App.Locals): Site {
  if (!locals.site) error(404, 'Not found');
  return locals.site;
}
