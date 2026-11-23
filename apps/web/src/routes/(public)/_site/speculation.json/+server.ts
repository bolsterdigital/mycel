// Serve the same checked-in rules on every site with the media type the browser requires.
// Rejected: serving JSON as an adapter static asset, which gives it application/json.
import rules from '#lib/server/http/speculation-rules.json';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () =>
  new Response(JSON.stringify(rules), {
    headers: {
      'content-type': 'application/speculationrules+json',
      'cache-control': 'public, max-age=300',
    },
  });
