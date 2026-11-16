// A generated share card under the site; the rules are in lib/server/public/share-card.ts.
import { shareCardResponse } from '#lib/server/public/share-card.js';
import { requireSite } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params, locals }) =>
  shareCardResponse(requireSite(locals), params);
