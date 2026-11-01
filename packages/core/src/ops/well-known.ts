// The two discovery documents of an installation, as pure text so that every host serves the same
// thing: the web front on the sites and the platform origin, the API on its own hostname. Both exist
// only when the operator configured what they state; a document with an invented contact or a
// guessed API address is worse than a 404.
//
// `Expires` is rolled at read time, because the value is only as true as the configuration behind
// it and that is read on every request. Rejected: an expiry date in the configuration, which lapses
// unnoticed a year after installation and then tells researchers the contact is dead, and
// `Canonical`, which only pays with a signature and would echo the request's host for nothing.
//
// The catalog names the site's own read route where there is a site, so an agent that arrives on a
// custom domain can read that site. The slug it shows is no secret: the platform hostname
// `<slug>.<domain>` already redirects to the custom domain. Rejected: one catalog for every host,
// which leaves that agent with an OpenAPI document and no value for its `{tenant}`.

const DAY_MS = 24 * 60 * 60 * 1000;

export const WELL_KNOWN_SECURITY_TXT = '/.well-known/security.txt';
export const WELL_KNOWN_API_CATALOG = '/.well-known/api-catalog';

export const SECURITY_TXT_TYPE = 'text/plain; charset=utf-8';
export const API_CATALOG_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
export const API_CATALOG_LINK = `<${WELL_KNOWN_API_CATALOG}>; rel="api-catalog"; type="application/linkset+json"`;
export const WELL_KNOWN_CACHE = 'public, max-age=86400';

/** RFC 9116 advises less than a year ahead; half a year outlives any cache of the file. */
const SECURITY_TXT_VALID_DAYS = 180;

/** RFC 9116. `contact` is a validated `mailto:`, `https:` or `tel:` URI from the configuration. */
export function securityTxt(contact: string, now: Date): string {
  const expires = new Date(now.getTime() + SECURITY_TXT_VALID_DAYS * DAY_MS);
  return `Contact: ${contact}\nExpires: ${expires.toISOString()}\n`;
}

/** RFC 9727: a linkset naming the API and its OpenAPI document; `slug` narrows it to one site. */
export function apiCatalog(apiUrl: string, slug?: string): string {
  const { origin } = new URL(apiUrl);
  return JSON.stringify({
    linkset: [
      {
        anchor: slug ? `${origin}/v1/sites/${slug}` : `${origin}/v1`,
        'service-desc': [
          { href: `${origin}/openapi.json`, type: 'application/vnd.oai.openapi+json;version=3.1' },
        ],
      },
    ],
  });
}
