// A page or article as Markdown: `?format=md` on its own address. It is the same read as
// the HTML (`loadPublicItem`: the publication pointer in the URL's locale, the access rule, the
// resolved links), rendered by `renderMarkdown` over that render model, never over raw revision
// JSON, so a draft, an unpublished locale or a restricted body is a 404 here exactly when it is
// one in HTML. The hooks call this before routing (hooks.server.ts), because a SvelteKit page
// route cannot answer with another content type.
//
// The canonical link is a `Link` header, as RFC 6596 allows for non-HTML. Rejected: a `.md`
// suffix on the path (a second address per item, which old-address forwarding and the reserved
// slugs would have to learn) and Accept negotiation (a cache would then need `Vary: Accept`).

import { createHash } from 'node:crypto';
import { isHttpError } from '@sveltejs/kit';
import { renderMarkdown } from '../../../blocks/markdown.js';
import { NO_STORE, PUBLIC_CACHE } from '../../http/http-cache.js';
import { siteUrls, type Site } from '../../site.js';
import { localeOf, parseContentPath } from '../content-route.js';
import { loadPublicItem } from '../public-page.js';

/** True for a read that asks for Markdown: `?format=md` and nothing else in the query. */
export const wantsMarkdown = (request: Request, url: URL) =>
  (request.method === 'GET' || request.method === 'HEAD') &&
  url.searchParams.get('format') === 'md' &&
  [...url.searchParams.keys()].length === 1;

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': NO_STORE },
  });

/**
 * The Markdown of the item at `path`, the path within the site (`/en/articles/x`, without the
 * development `/<tenant>` prefix), or a 404.
 */
export async function markdownResponse(site: Site, path: string): Promise<Response> {
  const parts = path.split('/').filter(Boolean);
  const prefix = parts[0] && site.tenant.locales.includes(parts[0]) ? parts.shift() : undefined;
  const locale = localeOf(prefix, site.tenant);
  const route = parseContentPath(parts.join('/'));
  if (!locale || !route || route.thanks) return notFound();
  let view;
  try {
    view = await loadPublicItem(site, route, locale);
  } catch (e) {
    if (isHttpError(e, 404)) return notFound();
    throw e;
  }
  const siteRoot = (await siteUrls(site))('/').replace(/\/$/, '');
  const body = renderMarkdown(view.model, {
    canonicalUrl: view.head.canonical,
    siteRoot,
    lead: view.intro.lead,
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': PUBLIC_CACHE,
      'x-content-type-options': 'nosniff',
      link: `<${view.head.canonical}>; rel="canonical"`,
      etag: `"${createHash('sha256').update(body).digest('base64url')}"`,
      ...(view.head.noindex ? { 'x-robots-tag': 'noindex' } : {}),
    },
  });
}
