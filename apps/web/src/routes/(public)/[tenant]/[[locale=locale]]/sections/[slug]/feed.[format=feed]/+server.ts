// One section's feed of articles. A section has no page of its own yet, so the feed's
// home link is the site; an overview block filtered on the section is where a reader browses it.
import { Slug } from '@mycel/core';
import { refuse } from '#lib/server/http/refuse.js';
import { feedResponse } from '#lib/server/public/text/feed.js';
import { requireSite } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
  if (!Slug.safeParse(params.slug).success) refuse(404);
  const format = params.format === 'xml' ? 'rss' : 'atom';
  return feedResponse(requireSite(locals), params.locale, format, { section: params.slug }, '/');
};
