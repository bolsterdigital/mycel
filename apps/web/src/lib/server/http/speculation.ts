// Speculation rules for the public site (checklist item speculation-rules): when a visitor holds
// the pointer on a same-origin link, the browser fetches that page ahead, so the click paints
// without waiting for the server. A browser without support ignores the header.
//
// The rules travel in a `Speculation-Rules` response header pointing at a same-origin JSON file,
// so `script-src 'self'` stays as it is and a public page still ships no script. Prefetch only:
// it fetches the document and runs nothing, so a managed tag (ADR 022) cannot count a visit that
// never happened. Moderate eagerness acts on hover, not on everything in view, which keeps the
// extra server work to links a visitor is about to choose.
//
// Fetching ahead must never do anything, so a GET with an effect stays out by being a rule that
// is not matched rather than by trusting each route: the confirmation page (it only reads, but
// holds a token), media files, the admin, and any URL with a query. A form page may be fetched
// ahead: its timing token is then a few seconds older, which only a visitor can cause.
//
// Rejected: an inline `<script type="speculationrules">`, which `script-src 'self'` refuses and
// which would need `'inline-speculation-rules'` in the policy, and prerender, which runs the
// page's scripts before the visitor arrives.

import { sitePath, type Site } from '#lib/server/site.js';

export const SPECULATION_RULES_TYPE = 'application/speculationrules+json';

/** Under the site, next to `_theme`: a `Slug` starts with `[a-z0-9]`, so no page can take it. */
const RULES_FILE = '/_speculation.json';

// Each path twice: a hostname site serves `/confirm`, a development site `/probe/confirm`.
const NEVER_AHEAD = ['/confirm*', '/*/confirm*', '/media/*', '/*/media/*', '/admin*'];

// A query is a selector, not a pattern: Chromium 156 reads `/*\\?*` so that it matches every link,
// and with it nothing at all is fetched ahead.
const NEVER_AHEAD_LINKS = '[rel~="nofollow"], [download], [href*="?"]';

export const SPECULATION_RULES = {
  prefetch: [
    {
      where: {
        and: [
          { href_matches: '/*' },
          ...NEVER_AHEAD.map((path) => ({ not: { href_matches: path } })),
          { not: { selector_matches: NEVER_AHEAD_LINKS } },
        ],
      },
      eagerness: 'moderate',
    },
  ],
};

/** Points a served public HTML page at the rules; anything else stays as the route made it. */
export function applySpeculationRules(response: Response, site: Site): void {
  if (response.status !== 200) return;
  if (!response.headers.get('content-type')?.startsWith('text/html')) return;
  response.headers.set('speculation-rules', `"${sitePath(site, RULES_FILE)}"`);
}
