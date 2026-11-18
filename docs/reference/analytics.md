# Measurement data contract

Measurement is optional and off for every site until an administrator names a Plausible site. Mycel then counts pageviews of published public pages and accepted public signups in that Plausible site, and nothing else. There is no Mycel cookie, no visitor id and no event history of its own. The contract below is fixed in core (`packages/core/src/analytics/`) and shared by the browser script and the server events, so neither can send a field the other does not know (TODO #12).

**Status.** The setting, the closed catalogue, the delivery shape, the no-op transport, the pageview decision and the public pageview script are in place. The accepted-signup event and the Plausible transport for server events follow in two later pull requests; until then a configured site counts pageviews only.

## The setting

| Use case                    | Capability     | Returns                                                                                              |
| --------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `analytics.settings.get`    | `tenant:admin` | The setting with its version, the site's primary hostname and whether the configured site matches it |
| `analytics.settings.update` | `tenant:admin` | Sets or clears `plausibleDomain` at a known version; audited like every command                      |
| `analytics.tracker.get`     | `content:read` | `{ plausibleDomain }` only, for the public site; readable by anonymous visitors                      |

`plausibleDomain` is a Plausible **site identifier** such as `example.org`: lower-case DNS labels joined by dots, at least two labels, at most 253 characters. A scheme, port, path, query, fragment, user info or whitespace inside is refused; surrounding whitespace and upper case are normalised. It is never a URL Mycel fetches, never a script and never a CSP source. `null` is off, the default for every site. Editors cannot change it: which third party counts the site's visitors is the administrator's decision, like retention.

The value lives in `site_settings.analytics` (migration 0080), on the tenant's own row under forced RLS, with its own version so a save never overwrites another setting. It is exported and imported with the site and deleted with the tenant. A stored value that no longer parses reads as off. A suspended site keeps its setting and its counting, but cannot change it.

Changing the primary hostname does not rewrite the setting. The admin shows the mismatch so the administrator can correct it; `www.` on either side counts as the same site.

Clearing the setting stops counting from the next request on. It does not erase what Plausible already holds: delete the site or its data in Plausible ([site deletion](https://plausible.io/docs/delete-site-data)). Plausible owns the retention of its statistics.

## Server events

The catalogue is closed (`ANALYTICS_EVENTS`); the `Analytics` port accepts only a member of `AnalyticsEvent`.

| Event            | Purpose                                    | Props            | Kept by Mycel                                                              |
| ---------------- | ------------------------------------------ | ---------------- | -------------------------------------------------------------------------- |
| `form.submitted` | Count accepted public signups by form kind | `kind: 'signup'` | Only the source outbox event, for its lifecycle (30 days after processing) |

Not in the catalogue, on purpose: `form.confirmed` (a consent confirmation is not a conversion) and any event with a form id, label, answer or address. `donation.paid` is reserved and refused until the owned ledger emits it once per paid payment, without amount, donor, mandate or provider reference.

A delivery (`AnalyticsDelivery`) carries the validated site identifier, the site root as a queryless URL built with `siteUrl`, and the catalogue event. It never carries a request, header, principal, supporter, submission, form value, visitor IP or user agent. Server events are therefore counts, not visitors, and Plausible may discard some of them as bot traffic. `NoopAnalytics` is the transport wherever no provider is configured and in every test.

A transport reports `accepted`, `rejected`, `retryable` (failed before anything was sent; one more bounded attempt cannot count twice), `unknown` (may have arrived; the Events API has no idempotency key, so this is never retried blindly) or `disabled`. A failed or slow provider never changes a form's outcome: delivery runs after the commit, from the outbox.

## Pageviews

`pageviewDecision` decides, before any script is on the page, whether a response counts and under which path. Only a successful `GET` of an HTML page that projects a published item with `public` access counts. Refused regardless of anything else:

- any path with a `confirm` segment, and any query with a key containing `token`, in any case or encoding;
- a query or path that does not decode;
- admin, reader, sign-in callback, preview, media, API, internal, form-action results, errors and redirects;
- a restricted item, also when an anonymous visitor sees only its teaser.

The reported path is rebuilt from the published item with `contentPath`, never taken from the request, so a query, fragment or alias host never reaches Plausible. A slug shaped like an identifier (a UUID, seven or more digits in a row, a long letters-and-digits token, anything outside the slug alphabet) is counted under its content type: `/-` for a page, `/articles/-` for an article.

## What the browser sends

Only the published content route asks for the decision, after the item has loaded; every other public route (confirmation, reader, giving, donation, search, people, media, feeds, errors) has no published item and gets nothing. An eligible page carries one tag, `<script defer src="/_site/pageview.js">`, with three data attributes: the fixed Plausible endpoint, the site identifier and the absolute URL of the decided path on the site's primary hostname. The script reads those attributes and nothing else of the page: not the browser's address, title, referrer, cookies or storage. It posts one request:

```json
{ "n": "pageview", "u": "https://example.org/articles/over-ons", "d": "example.org", "r": null }
```

The request carries no referrer and no credentials. Plausible's own script is not used: it reports the browser's address and referrer and would be a third-party script on the page. The identifier is part of the page's ETag, so switching measurement on or off is never hidden behind a cached `304`.

All sites count to one Plausible installation, `PLAUSIBLE_ORIGIN` in core (`https://analytics.dreamkit.eu`, EU-hosted). It is the only origin added to the Content-Security-Policy, as `connect-src`; `script-src` stays `'self'`. A tenant never chooses where its visitors' browsers send requests: an installation with its own Plausible changes the constant and the policy together, in review.

When the script runs, the visitor's browser contacts Plausible directly. Plausible then sees what any network request carries: the visitor's IP address and user agent, which it uses for its own daily visitor count without storing them. Whether a site needs consent for this depends on its deployment and is the operator's legal assessment; Mycel makes no claim that a banner is unnecessary. A site that adds a consent manager or tag manager does so through the managed-integration route (ADR 022, ADR 024), not through this setting.
