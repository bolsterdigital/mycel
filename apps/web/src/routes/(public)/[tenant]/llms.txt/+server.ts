// The site's llms.txt; content and limits: lib/server/public/text/llms.ts.
import { llmsResponse } from '#lib/server/public/text/llms.js';
import { requireSite } from '#lib/server/site.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => llmsResponse(requireSite(locals));
