// A held link can fetch its document ahead under the existing CSP. Prefetch does not run
// scripts, so the pageview script cannot count a visit before navigation. Rejected: inline
// rules that require a CSP exception and prerendering that would run those scripts early.
// The JSON's segment pattern covers both hostname and tenant-prefixed URLs, including
// locale prefixes. The positive pattern requires an empty query and avoids encoded path
// segments, which the router could decode into a reserved route. The selector also
// excludes a literal empty query, downloads, and nofollow links.
export const SPECULATION_RULES_PATH = '/_site/speculation.json';

/** Points a served public HTML page at the same-origin rules. */
export function applySpeculationRules(response: Response): void {
  if (response.status !== 200) return;
  if (!response.headers.get('content-type')?.startsWith('text/html')) return;
  response.headers.set('speculation-rules', `"${SPECULATION_RULES_PATH}"`);
}
