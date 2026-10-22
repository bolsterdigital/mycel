// The one builder of absolute site URLs (ADR 014 rule 6): confirmation mails, `pageUrl`, and
// later feeds, sitemaps and canonical links call this and nothing else builds a site URL from a
// request. Pure: the caller passes the tenant's primary hostname and the platform config.
//
// Scheme and port come from PUBLIC_BASE_URL, the host from the primary hostname: in production
// that is `https://<primary>/...`; in development `http://probe.localhost:5173/...`, which
// Chromium and Firefox resolve to loopback without a hosts entry. Rejected: a separate
// SITE_SCHEME setting, which would be one more thing to get wrong than the origin we already have.

import type { PlatformConfig } from './ports.js';

export interface SiteAddress {
  slug: string;
  /** The tenant's primary hostname, or null when it has none yet. */
  primaryHostname: string | null;
}

/**
 * `path` starts with `/` (query and fragment included as given). `locale` is reserved for the
 * i18n routing of TODO #8c (ADR 007: locale in the path, never in the hostname) and ignored
 * until then.
 */
export function siteUrl(
  site: SiteAddress,
  platform: Pick<PlatformConfig, 'platformOrigin' | 'siteUrlMode'>,
  path = '/',
  _locale?: string
): string {
  const base = new URL(platform.platformOrigin);
  if (platform.siteUrlMode === 'hostnames' && site.primaryHostname) {
    const port = base.port ? `:${base.port}` : '';
    return `${base.protocol}//${site.primaryHostname}${port}${path}`;
  }
  return `${base.origin}/${site.slug}${path === '/' ? '' : path}`;
}
