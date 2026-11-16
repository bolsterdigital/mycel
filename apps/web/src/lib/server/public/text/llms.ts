// The site's `/llms.txt` (llmstxt.org): the site's name, then per locale its published
// public pages and articles as Markdown links to their `?format=md` representation, each with
// its summary. The rows are `content.feed.get`: publication pointers only, public revisions
// only, without noindex items or items whose canonical is elsewhere, at most FEED_MAX of each type
// per locale, so a large site is a bounded file of its newest content and never one unbounded
// read. Every URL is absolute on the primary address; headings come from the site's catalog.
//
// Rejected: the full text of every page in one file (`llms-full.txt`; a large site makes it
// unbounded, and the per-page Markdown is one request away) and only the default locale (a site
// in two languages has two audiences).

import { createHash } from 'node:crypto';
import { FEED_MAX, anonymousPrincipal, contentPath, useCases } from '@mycel/core';
import { ui } from '../../../../i18n/index.js';
import { md } from '../../../blocks/markdown.js';
import { PUBLIC_CACHE } from '../../http/http-cache.js';
import { runtime } from '../../runtime.js';
import { siteTenant, siteUrls, type Site } from '../../site.js';

export async function llmsResponse(site: Site): Promise<Response> {
  const reader = anonymousPrincipal(siteTenant(site), ['content:read']);
  const absolute = await siteUrls(site);
  const { defaultLocale, locales } = site.tenant;
  const out = [`# ${md(site.tenant.name)}`];
  for (const locale of locales) {
    const t = ui(locale);
    for (const type of ['page', 'article'] as const) {
      const { entries } = await runtime().invoker.run(useCases.getFeed, reader, {
        locale,
        type,
        limit: FEED_MAX,
      });
      if (!entries.length) continue;
      const label = t(type === 'page' ? 'public.llms.pages' : 'public.llms.articles');
      out.push(
        `## ${md(label)} (${locale})`,
        entries
          .map((e) => {
            const url = `${absolute(contentPath(e, locale, defaultLocale))}?format=md`;
            return `- [${md(e.title)}](<${url}>)${e.summary ? `: ${md(e.summary)}` : ''}`;
          })
          .join('\n')
      );
    }
  }
  const body = `${out.join('\n\n')}\n`;
  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': PUBLIC_CACHE,
      'x-content-type-options': 'nosniff',
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
    },
  });
}
