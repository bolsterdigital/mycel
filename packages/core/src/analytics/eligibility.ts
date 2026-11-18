// Whether a response may count as a pageview, and under which address (docs/reference/analytics.md
// § Pageviews). Pure and framework-free: the public web gate (PR 2) describes the response it
// is about to send and gets back either a refusal or the one queryless, site-relative path the
// script may report. The decision is made before any script exists on the page, so stripping a
// query or a token later, in a report, is never what keeps it out.
//
// Deny is the default. Only a successful GET of an HTML page that projects a published item of
// `public` access is eligible; everything else (admin, reader, callback, preview, media, API,
// form-action results, errors, redirects, a restricted teaser even for an anonymous visitor) is
// refused by its representation alone. On top of that, a path with a `confirm` segment or a query
// with any key naming a token is refused whatever the representation claims, and a query that
// does not parse is refused rather than guessed at.
//
// The reported path is rebuilt from the published item with `contentPath`, never taken from the
// request, so a query, fragment or alias host can never reach it. A slug that fails the
// conservative identifier rule (an address, a UUID, a long number or a token-like run) is counted
// under its content type instead (`/articles/-`, `/-`).
//
// Rejected: an allowlist of SvelteKit route ids (it would tie core to the web front and miss a
// representation that reuses a route), and reporting `window.location` with the query stripped
// (the browser would still send the full referrer and path; Plausible's own stripping is too late).

import { contentPath } from '../content/public.js';
import type { ContentType } from '../content/model.js';

/**
 * What the public front is about to send. `published` is the item the response projects, set
 * only when the representation is the published page of that item; every other representation
 * says what it is so the refusal can name it.
 */
export interface PageviewRequest {
  method: string;
  status: number;
  /** The response's `content-type`, or null when it has none yet (an HTML page). */
  contentType: string | null;
  /** The request's pathname, site-relative or not; only its segments are inspected. */
  pathname: string;
  /** The raw query string, with or without its leading `?`; empty when there is none. */
  search: string;
  representation:
    | 'published'
    | 'admin'
    | 'reader'
    | 'callback'
    | 'preview'
    | 'media'
    | 'api'
    | 'internal'
    | 'form-action'
    | 'error'
    | 'redirect'
    | 'other';
  /** The published item this page projects, with the access it was published under. */
  published: {
    type: ContentType;
    slug: string;
    access: 'public' | 'restricted';
    locale: string;
    defaultLocale: string;
  } | null;
}

export type PageviewRefusal =
  | 'method'
  | 'status'
  | 'not-html'
  | 'confirm'
  | 'token'
  | 'malformed-query'
  | 'malformed-path'
  | 'representation'
  | 'restricted';

export type PageviewDecision =
  | { eligible: true; path: string; aggregated: boolean }
  | { eligible: false; reason: PageviewRefusal };

/** Where a slug that fails `isSafeSlug` is counted: the content type, not the item. */
export const AGGREGATE_SLUG = '-';

const UUID = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62})$/;

/**
 * The conservative identifier rule for a slug in a reported path: the content slug alphabet, and
 * nothing shaped like an identifier of a person or a secret. Refused: a UUID (hyphenated or not),
 * a run of seven or more digits (a phone number, an account or order number) and a hyphen-free
 * run of twenty or more characters mixing letters and digits (a token). Dates (`2026-11-18`) and
 * ordinary words pass.
 */
export function isSafeSlug(slug: string): boolean {
  if (!SLUG.test(slug)) return false;
  if (UUID.test(slug)) return false;
  if (/\d{7,}/.test(slug)) return false;
  return !slug
    .split('-')
    .some((part) => part.length >= 20 && /\d/.test(part) && /[a-z]/.test(part));
}

/** True when the query cannot be read, or has a key that names a token in any case or position. */
function queryProblem(search: string): 'token' | 'malformed-query' | null {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  if (!raw) return null;
  for (const pair of raw.split(/[&;]/)) {
    const key = pair.split('=', 1)[0] ?? '';
    let decoded: string;
    try {
      decoded = decodeURIComponent(key.replace(/\+/g, ' '));
    } catch {
      return 'malformed-query';
    }
    if (/token/i.test(decoded) || /token/i.test(key)) return 'token';
  }
  return null;
}

/** `confirm` when a decoded segment is `confirm` (the route and all under it); `malformed-path` when one does not decode. */
function pathProblem(pathname: string): 'confirm' | 'malformed-path' | null {
  for (const segment of pathname.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return 'malformed-path';
    }
    if (decoded.toLowerCase() === 'confirm') return 'confirm';
  }
  return null;
}

/**
 * The pageview decision for one response. The order puts the route rules (confirm, token) before
 * the representation, so a regression in how a front labels a confirm page can still not count it.
 */
export function pageviewDecision(request: PageviewRequest): PageviewDecision {
  if (request.method.toUpperCase() !== 'GET') return { eligible: false, reason: 'method' };
  if (request.status !== 200) return { eligible: false, reason: 'status' };
  if (request.contentType !== null && !/^text\/html(?:\s*;|$)/i.test(request.contentType))
    return { eligible: false, reason: 'not-html' };
  const path = pathProblem(request.pathname);
  if (path) return { eligible: false, reason: path };
  const query = queryProblem(request.search);
  if (query) return { eligible: false, reason: query };
  if (request.representation !== 'published' || !request.published)
    return { eligible: false, reason: 'representation' };
  const { type, slug, access, locale, defaultLocale } = request.published;
  if (access !== 'public') return { eligible: false, reason: 'restricted' };
  const safe = isSafeSlug(slug);
  return {
    eligible: true,
    path: contentPath({ type, slug: safe ? slug : AGGREGATE_SLUG }, locale, defaultLocale),
    aggregated: !safe,
  };
}
