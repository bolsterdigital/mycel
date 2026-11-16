// One person's feed of the articles they wrote, next to their public page: it exists
// exactly where that page does (`content.feed.get` checks the same rule).
import { Slug } from '@mycel/core';
import { refuse } from '#lib/server/http/refuse.js';
import { feedResponse } from '#lib/server/public/text/feed.js';
import { requireSite } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
  if (!Slug.safeParse(params.slug).success) refuse(404);
  const format = params.format === 'xml' ? 'rss' : 'atom';
  const home = `/people/${params.slug}`;
  return feedResponse(requireSite(locals), params.locale, format, { author: params.slug }, home);
};
