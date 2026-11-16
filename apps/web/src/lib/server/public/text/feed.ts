// RSS 2.0 and Atom feeds of a site, a section or a person, from `content.feed.get`:
// the published public articles in one locale, newest first, with the featured title and summary.
// The locale is the URL's (`/feed.xml` the default, `/en/feed.xml` English), never the request's
// Accept-Language, so one URL is one cacheable document. Every link is an absolute URL on the
// site's primary address (`siteUrls`), never one built from the Host header.
//
// Text goes in as escaped XML text, never as markup: a summary is plain text in the core, so no
// rich-text link or HTML reaches a feed reader. An unknown section or person is a 404, which the
// hooks give `no-store`. The ETag hashes the body, which changes with every publication, title or
// summary that the feed shows.
//
// Rejected: one format only (readers still differ in which they expect, and both are a few
// lines over the same entries) and the full article body in the feed (a reader follows the link,
// and the HTML page applies access and consent rules the feed cannot).

import { createHash } from 'node:crypto';
import { UseCaseError, anonymousPrincipal, contentPath, useCases } from '@mycel/core';
import { PUBLIC_CACHE } from '../../http/http-cache.js';
import { refuse } from '../../http/refuse.js';
import { runtime } from '../../runtime.js';
import { siteTenant, siteUrls, type Site } from '../../site.js';
import { localeOf } from '../content-route.js';

export type FeedFormat = 'rss' | 'atom';

/** Whose feed: the site's, one section's or one person's, by slug. */
export type FeedScope = { section?: string; author?: string };

const FEED_SIZE = 20;

export const xml = (s: string) =>
  s.replace(
    // Characters XML 1.0 does not allow at all, then the five with a meaning.
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? ''
  );

export interface FeedDocument {
  title: string;
  /** The HTML page the feed belongs to. */
  home: string;
  /** The feed's own URL. */
  self: string;
  locale: string;
  entries: { id: string; url: string; title: string; summary: string | null; date: string }[];
}

export function rss(feed: FeedDocument): string {
  const items = feed.entries.map(
    (e) =>
      `<item><title>${xml(e.title)}</title><link>${xml(e.url)}</link><guid isPermaLink="true">${xml(e.url)}</guid><pubDate>${new Date(e.date).toUTCString()}</pubDate>${e.summary ? `<description>${xml(e.summary)}</description>` : ''}</item>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(feed.title)}</title><link>${xml(feed.home)}</link><description>${xml(feed.title)}</description><language>${xml(feed.locale)}</language><atom:link href="${xml(feed.self)}" rel="self" type="application/rss+xml"/>${items.join('')}</channel></rss>`;
}

export function atom(feed: FeedDocument): string {
  // The feed's `updated` is its newest entry; an empty feed has nothing newer than the epoch.
  const updated = feed.entries[0]?.date ?? new Date(0).toISOString();
  const entries = feed.entries.map(
    (e) =>
      `<entry><title>${xml(e.title)}</title><link rel="alternate" type="text/html" href="${xml(e.url)}"/><id>${xml(e.url)}</id><published>${e.date}</published><updated>${e.date}</updated>${e.summary ? `<summary>${xml(e.summary)}</summary>` : ''}</entry>`
  );
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${xml(feed.locale)}"><title>${xml(feed.title)}</title><id>${xml(feed.self)}</id><link rel="self" type="application/atom+xml" href="${xml(feed.self)}"/><link rel="alternate" type="text/html" href="${xml(feed.home)}"/><updated>${updated}</updated><author><name>${xml(feed.title)}</name></author>${entries.join('')}</feed>`;
}

/** The feed's file name after `path`: `feed.xml` (RSS) or `feed.atom`. */
export const feedFile = (format: FeedFormat) => (format === 'rss' ? 'feed.xml' : 'feed.atom');

/**
 * The feed of `scope` in the URL's locale (`prefix`: the optional locale segment), as a response.
 * `home` is the site path of the HTML page the feed belongs to, without the locale prefix.
 */
export async function feedResponse(
  site: Site,
  prefix: string | undefined,
  format: FeedFormat,
  scope: FeedScope,
  home: string
): Promise<Response> {
  const locale = localeOf(prefix, site.tenant);
  if (!locale) refuse(404);
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  let result;
  try {
    result = await runtime().invoker.run(useCases.getFeed, reader, {
      locale,
      ...scope,
      limit: FEED_SIZE,
    });
  } catch (e) {
    if (e instanceof UseCaseError && e.code === 'not_found') refuse(404);
    throw e;
  }
  const absolute = await siteUrls(site);
  const { defaultLocale } = site.tenant;
  const localePrefix = locale === defaultLocale ? '' : `/${locale}`;
  const homePath = `${localePrefix}${home}` || '/';
  const doc: FeedDocument = {
    title: result.name ? `${site.tenant.name}: ${result.name}` : site.tenant.name,
    home: absolute(homePath),
    self: absolute(`${localePrefix}${home === '/' ? '' : home}/${feedFile(format)}`),
    locale,
    entries: result.entries.map((e) => ({
      id: e.id,
      url: absolute(contentPath(e, locale, defaultLocale)),
      title: e.title,
      summary: e.summary,
      date: e.date,
    })),
  };
  const body = format === 'rss' ? rss(doc) : atom(doc);
  return new Response(body, {
    headers: {
      'content-type': `${format === 'rss' ? 'application/rss+xml' : 'application/atom+xml'}; charset=utf-8`,
      'cache-control': PUBLIC_CACHE,
      'x-content-type-options': 'nosniff',
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    },
  });
}
