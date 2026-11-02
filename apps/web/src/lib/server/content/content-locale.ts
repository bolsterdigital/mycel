// The content locale (#66 PR 4, brief edit-screen § 9 point 4): an editor works in one language
// at a time across the whole admin, as in Payload, WordPress and Strapi. Lists and the edit screen
// follow one choice, made in the shell or in the item's bar, and kept in a cookie scoped to the
// tenant's admin path, so each site remembers its own; without a choice it is the site's default
// locale. `?locale=` on an item names a locale for that view only (a link, a publication's
// return) without changing the choice. Rejected: a per-operator preference in `mycel_auth` (one
// site's languages are not another's, and #88 keeps preferences for the admin's own display) and
// the locale in every admin URL (every link of the shell would have to carry it).
import { readinessIssues, type ContentDocument } from '@mycel/core';
import type { Cookies } from '@sveltejs/kit';

const COOKIE = 'mycel-content-locale';

/** The cookie's path: one choice per site. */
const pathOf = (tenant: string) => `/admin/${tenant}`;

/**
 * The locale to show: `asked` (the item's `?locale=`) when it is one of `allowed`, else the
 * stored choice when the site still has it, else the site's default locale.
 */
export function contentLocale(
  cookies: Cookies,
  site: { locales: readonly string[]; defaultLocale: string },
  asked?: string | null,
  allowed: readonly string[] = site.locales
): string {
  if (asked && allowed.includes(asked)) return asked;
  const chosen = cookies.get(COOKIE);
  return chosen && site.locales.includes(chosen) ? chosen : site.defaultLocale;
}

/** Stores the choice for this site's admin, for a year. */
export function chooseContentLocale(cookies: Cookies, tenant: string, locale: string): void {
  cookies.set(COOKIE, locale, {
    path: pathOf(tenant),
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 365,
  });
}

/**
 * Where a translation stands: `missing` when the document lacks the locale, `behind` when a field
 * that another locale has is empty in it (core's readiness, `missing-translation`), else `ok`.
 */
export type TranslationState = 'ok' | 'behind' | 'missing';

export function translationState(doc: ContentDocument, locale: string): TranslationState {
  if (!doc.locales.includes(locale)) return 'missing';
  return readinessIssues(doc, locale).some(
    (i) => i.message === 'content.publish.missing-translation'
  )
    ? 'behind'
    : 'ok';
}

/** An admin path to return to after a choice, without its own `locale`; null if it is not one. */
export function returnPath(raw: string, tenant: string): string | null {
  if (!raw.startsWith(`${pathOf(tenant)}`) || raw.startsWith('//')) return null;
  const url = new URL(raw, 'http://admin.invalid');
  if (url.origin !== 'http://admin.invalid') return null;
  url.searchParams.delete('locale');
  const path = url.pathname;
  if (path !== pathOf(tenant) && !path.startsWith(`${pathOf(tenant)}/`)) return null;
  return `${path}${url.search}`;
}
