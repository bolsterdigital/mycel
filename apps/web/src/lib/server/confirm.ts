// What the two confirm routes share (TODO #22B): the headers, the copy per outcome, the path of
// a tokenless outcome page and the language of the answer. The page with the token
// (`confirm/+page.server.ts`) and the outcome after the post (`confirm/[outcome]`) must look and
// behave as one flow, so they read it from here.
//
// Headers: the token is a credential for one consent, so no response of the flow may be stored
// or leak it through `Referer`. `strict-origin` sends at most the origin, never the path or the
// query, to anyone. Rejected: `no-referrer`, which the brief named: under it a browser sends
// `Origin: null` with the form's POST (Fetch, "serializing a request origin"), and SvelteKit's
// CSRF check then refuses the person's own click as cross-site. `applySecurityHeaders` sets the
// public referrer policy only when the route set none, so this one wins (the e2e suite proves it).

import { negotiateLocale, type ConfirmResult } from '@mycel/core';
import type { UiKey } from '../../i18n/index.js';
import { NO_STORE } from './http-cache.js';
import { sitePath, type Site } from './site.js';

export const CONFIRM_HEADERS = { 'cache-control': NO_STORE, 'referrer-policy': 'strict-origin' };

export type Outcome = ConfirmResult['status'];

export const OUTCOME_COPY: Record<Outcome, { title: UiKey; body: UiKey }> = {
  confirmed: { title: 'confirm.ok.title', body: 'confirm.ok.body' },
  already_confirmed: { title: 'confirm.already.title', body: 'confirm.already.body' },
  invalid: { title: 'confirm.invalid.title', body: 'confirm.invalid.body' },
};

/** The path segment of each outcome page; anything else under `confirm/` is a 404. */
const SEGMENT: Record<Outcome, string> = {
  confirmed: 'confirmed',
  already_confirmed: 'already-confirmed',
  invalid: 'invalid',
};

export const outcomeOf = (segment: string): Outcome | undefined =>
  (Object.keys(SEGMENT) as Outcome[]).find((o) => SEGMENT[o] === segment);

/**
 * The tokenless page an outcome redirects to, carrying the signup's locale so the answer stays
 * in the language the person signed up in. Rejected: the locale as a path prefix
 * (`/en/confirm/...` would compete with the content route's grammar for one page).
 */
export function outcomePath(site: Site, outcome: Outcome, locale: string | undefined): string {
  const path = sitePath(site, `/confirm/${SEGMENT[outcome]}`);
  return locale ? `${path}?locale=${encodeURIComponent(locale)}` : path;
}

/** The signup's locale when the site still has it, otherwise negotiated like any other page. */
export function answerLocale(site: Site, request: Request, locale: string | null | undefined) {
  const { tenant } = site;
  if (locale && tenant.locales.includes(locale)) return locale;
  return negotiateLocale(
    request.headers.get('accept-language'),
    tenant.locales,
    tenant.defaultLocale
  );
}
