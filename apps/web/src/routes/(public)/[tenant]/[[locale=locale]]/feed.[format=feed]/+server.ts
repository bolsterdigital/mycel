// The site's feed of articles: `/feed.xml` (RSS) and `/feed.atom`, per locale prefix.
// Rendering and caching: lib/server/public/text/feed.ts.
import { feedResponse } from '#lib/server/public/text/feed.js';
import { requireSite } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) =>
  feedResponse(
    requireSite(locals),
    params.locale,
    params.format === 'xml' ? 'rss' : 'atom',
    {},
    '/'
  );
