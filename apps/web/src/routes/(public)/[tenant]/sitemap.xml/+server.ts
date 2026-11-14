// The site's sitemap: every published locale of a page or article from the public list
// (`content.published.list`, the publication pointers, never a draft), plus the public people.
// A `noindex` locale is left out. A restricted item is listed with its address only: the list
// carries no text, and its body stays behind the access rule (ADR 018; the public route answers
// 404 until readers sign in). `lastmod` is the save of the published revision, so a later draft does not move
// it. The alternates of a URL are the ones its page names in its own head (`public-page.ts`):
// every published locale plus `x-default`, so the head and the sitemap agree.
//
// Size: one response holds at most SEGMENT list rows. A site with more gets a sitemap index at
// this same address whose parts are `?from=start` and `?from=<cursor>`, each a cursor of the list
// at a segment boundary; the people go in the first part. The index walks the light rows of the
// list once to find those boundaries. Rejected: page numbers (`?page=n`, an offset: a
// publication between the index and a part shifts every later part, so a crawl repeats or skips
// URLs), a URL per row without a bound (a large site would be one unbounded response), and a
// second address for the index (crawlers read `/sitemap.xml`, and robots.txt names one URL).

import { createHash } from 'node:crypto';
import {
  anonymousPrincipal,
  contentPath,
  PUBLISHED_CURSOR,
  useCases,
  type Principal,
  type PublishedListEntry,
} from '@mycel/core';
import { personPath } from '#lib/public/person-path.js';
import { PUBLIC_CACHE } from '#lib/server/http/http-cache.js';
import { refuse } from '#lib/server/http/refuse.js';
import { runtime } from '#lib/server/runtime.js';
import { requireSite, siteTenant, siteUrls, type Site } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

/** List rows per sitemap response; the protocol allows 50,000 URLs. */
const SEGMENT = 1000;
const PAGE = 100;

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!
  );

/** Up to SEGMENT rows of the list after `after`, and the cursor past them (null: the end). */
async function segment(reader: Principal, after: string | undefined) {
  const rows: PublishedListEntry[] = [];
  let next: string | null = after ?? null;
  do {
    const page = await runtime().invoker.run(useCases.listPublished, reader, {
      ...(next ? { after: next } : {}),
      limit: Math.min(PAGE, SEGMENT - rows.length),
    });
    rows.push(...page.items);
    next = page.next;
  } while (next && rows.length < SEGMENT);
  return { rows, next };
}

async function people(site: Site, reader: Principal, absolute: (path: string) => string) {
  const urls: string[] = [];
  for (const locale of site.tenant.locales) {
    let after: string | undefined;
    do {
      const page = await runtime().invoker.run(useCases.listPublicPeople, reader, {
        locale,
        after,
        limit: PAGE,
      });
      urls.push(
        ...page.people.map(
          (person) =>
            `<url><loc>${xml(absolute(personPath(person.slug, locale, site.tenant.defaultLocale)))}</loc></url>`
        )
      );
      after = page.next ?? undefined;
    } while (after);
  }
  return urls;
}

function contentUrl(
  row: PublishedListEntry,
  defaultLocale: string,
  absolute: (p: string) => string
) {
  const href = (l: string) => xml(absolute(contentPath(row, l, defaultLocale)));
  const fallback = row.locales.includes(defaultLocale) ? defaultLocale : row.locales[0]!;
  const alternates = [...row.locales.map((l) => [l, href(l)]), ['x-default', href(fallback)]].map(
    ([l, h]) => `<xhtml:link rel="alternate" hreflang="${l}" href="${h}"/>`
  );
  return `<url><loc>${href(row.locale)}</loc><lastmod>${row.updatedAt}</lastmod>${alternates.join('')}</url>`;
}

function respond(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': PUBLIC_CACHE,
      'x-content-type-options': 'nosniff',
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    },
  });
}

const urlset = (urls: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${urls.join('')}</urlset>`;

export const GET: RequestHandler = async ({ locals, url }) => {
  const site = requireSite(locals);
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  const absolute = await siteUrls(site);
  const { defaultLocale } = site.tenant;
  const from = url.searchParams.get('from');
  if (from !== null && from !== 'start' && !PUBLISHED_CURSOR.test(from)) refuse(404);

  const first = await segment(reader, from && from !== 'start' ? from : undefined);
  const content = first.rows
    .filter((row) => !row.noindex)
    .map((row) => contentUrl(row, defaultLocale, absolute));
  if (from !== null)
    return respond(
      urlset(from === 'start' ? [...content, ...(await people(site, reader, absolute))] : content)
    );
  if (!first.next) return respond(urlset([...content, ...(await people(site, reader, absolute))]));

  // Larger than one response: an index of parts, each starting at a segment boundary.
  const parts = ['start'];
  let next: string | null = first.next;
  while (next) {
    parts.push(next);
    next = (await segment(reader, next)).next;
  }
  const self = absolute('/sitemap.xml');
  const entries = parts.map((p) => `<sitemap><loc>${xml(`${self}?from=${p}`)}</loc></sitemap>`);
  return respond(
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</sitemapindex>`
  );
};
