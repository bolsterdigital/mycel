// The site's own consent choice (docs/reference/integrations.md § Consent): one first-party
// cookie, `mycel_consent`, holding a version and the categories the visitor granted, `1` alone
// meaning necessary only. The browser writes it from the banner (`static/_site/consent.js`) and the
// choice page writes it without JavaScript (`/_consent`); both use the format here, which
// `consent.test.ts` holds the script to. The server reads it only on the choice page, which is
// private: a content page never depends on it, so it stays cacheable.
// Rejected: an external consent platform (a third party on every page before any choice) and
// one cookie per category (the version would have to be repeated or could disagree).

import { CONSENT_CATEGORIES, type ConsentCategory } from '@mycel/core';
import { sitePath, type Site } from '../../site.js';

export const CONSENT_COOKIE = 'mycel_consent';
export const CONSENT_VERSION = '1';
/** 180 days, in seconds. */
export const CONSENT_MAX_AGE = 180 * 24 * 60 * 60;
/** The choice page under a site's own path. */
export const CONSENT_PATH = '/_consent';

/** The categories a cookie value grants, or null for no (readable) choice. */
export function parseConsent(value: string | undefined): ConsentCategory[] | null {
  if (!value || value.length > 100) return null;
  const [version, ...rest] = value.split('.');
  if (version !== CONSENT_VERSION) return null;
  return CONSENT_CATEGORIES.filter((category) => rest.includes(category));
}

export function serializeConsent(granted: readonly ConsentCategory[]): string {
  return [CONSENT_VERSION, ...CONSENT_CATEGORIES.filter((c) => granted.includes(c))].join('.');
}

/** One choice per site: the cookie lives under the site's path, `/` on its own host. */
export const consentCookiePath = (site: Site): string => sitePath(site, '') || '/';

/** The choice page, returning to `path` afterwards. */
export const consentHref = (site: Site, path: string): string =>
  `${sitePath(site, CONSENT_PATH)}?${new URLSearchParams({ return: path })}`;
