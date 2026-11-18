// One pageview for a site that opted into measurement (docs/reference/analytics.md § Pageviews).
// The server decided before this tag existed that the page counts, and under which address
// (`pageviewDecision`); this file only sends that decision. It reads the three values on its own
// tag and nothing else of the page: never the browser's address, title, referrer or storage, so a
// query, fragment, token or alias host that passed the route rules still cannot reach Plausible.
// `r` is null and the request carries no referrer and no credentials.
//
// A plain classic file in `static/`, served from the site's own origin, so `script-src 'self'`
// covers it without a nonce; the request goes to the one origin `connect-src` names. `no-cors`
// with a text body is a simple request: no preflight, and nothing of the answer is read.
// Rejected: Plausible's own script, which reports `location.href` and `document.referrer` and
// would be a third-party script on every counted page, and its manual mode, which still needs an
// inline call that the nonce policy would have to carry.
(() => {
  const tag = document.currentScript;
  if (!tag) return;
  const { endpoint, domain, url } = tag.dataset;
  if (!endpoint || !domain || !url) return;
  fetch(endpoint, {
    method: 'POST',
    mode: 'no-cors',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    keepalive: true,
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ n: 'pageview', u: url, d: domain, r: null }),
  }).catch(() => {});
})();
