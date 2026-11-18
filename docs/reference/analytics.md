# Measurement data contract

Measurement is optional and off for every site until an administrator names a Plausible site. Mycel then counts pageviews of published public pages and accepted public signups in that Plausible site, and nothing else. There is no Mycel cookie, no visitor id and no event history of its own. The contract below is fixed in core (`packages/core/src/analytics/`) and shared by the browser script and the server events, so neither can send a field the other does not know (TODO #12).

**Status.** The setting, the closed catalogue, the delivery shape, the pageview decision, the public pageview script, the accepted-signup intent, its subscriber and the Plausible transport are in place. The worker sends server events when the installation sets `ANALYTICS_PROVIDER=plausible`; with the default `none` a configured site counts pageviews only.

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

### How an accepted signup is counted

`form.submit` publishes one `analytics.intent` outbox event when it accepts a submission to a `signup` form from an anonymous visitor on a site that measures (`countForAnalytics`, `analytics/events.ts`). It is published in the submission's own transaction, so a rollback takes it along. Its props are exactly the catalogue event, `{ name: 'form.submitted', props: { kind: 'signup' } }`, and its actor is `{ kind: 'anonymous', channel }` without the IP hash: no address, form, submission, list or page URL. Nothing is published for an invalid or rejected submission, another form kind, an integration's post (API key, import), a site without a Plausible site, or a confirmation: `mailing.opt_in.confirm` publishes no intent. The existing `form.submitted` domain event of a confirmed campaign signup is a different thing and is never sent.

The subscriber `analytics.delivery` (`analytics/delivery.ts`) handles each intent at most once:

1. It drops an intent that does not parse as a catalogue event (`malformed`, also a reserved `donation.paid`) or is older than an hour (`expired`, because Plausible dates an event on receipt).
2. In one transaction under the intent's tenant it rereads the setting (`off` when cleared since the signup), claims the event id in the rate-limit windows (`duplicate` when already claimed) and reads the primary hostname. The claim commits before anything is sent, so a redelivered event, a crashed drain or a second worker sends nothing. The claim lives a day; the hour's window keeps every deliverable intent inside it.
3. It sends the site root (`siteUrl(tenant, '/')`), the identifier and the event. `retryable` gets one more attempt, then stops; `unknown`, and a transport that throws, is never retried.

It never throws after the claim, so the outbox marks the intent handled and keeps no retry or dead row for it. A count lost to a crash between claim and send is the accepted side of at-most-once. Each intent logs one `analytics.delivery` line with tenant, event id, catalogue name and result; `unknown`, `malformed` and a missing tenant are warnings. The line never carries the identifier, a URL or the provider's answer.

### The Plausible transport

`PlausibleAnalytics` (`packages/analytics-plausible`) is the transport the worker composes when `ANALYTICS_PROVIDER=plausible` (default `none`: `NoopAnalytics`, every result `disabled`). It posts one request per delivery to `PLAUSIBLE_EVENT_ENDPOINT`, the same core constant as the browser script and the CSP; the endpoint is not configurable, and only a test may point it at a loopback server (`PLAUSIBLE_FIXTURE_ORIGIN`, refused in production). The body is the delivery and nothing else:

```json
{
  "name": "form.submitted",
  "url": "https://example.org/",
  "domain": "example.org",
  "props": { "kind": "signup" }
}
```

The request carries Mycel's own user agent (`Mycel (server event)`, which the Events API requires) and `content-type`, and nothing of the visitor: no `X-Forwarded-For`, cookie, referrer or origin. Plausible therefore sees the worker's address, so all server events of a day count as one visitor of the site; read them as event counts. Each attempt gives up after three seconds, because the outbox delivers a batch serially and a slow provider would hold up the mails behind it; with the one retry a dead provider costs a drain six seconds.

| Plausible's answer                                          | Outcome     | Sent again |
| ----------------------------------------------------------- | ----------- | ---------- |
| 2xx                                                         | `accepted`  | no         |
| 202 with `x-plausible-dropped: 1` (a site it does not know) | `rejected`  | no         |
| other 3xx or 4xx; a redirect is not followed                | `rejected`  | no         |
| 429, 503, a refused or unresolvable connection              | `retryable` | once       |
| other 5xx, a timeout, a reset or any other failure          | `unknown`   | no         |

The response body is never read. The adapter's tests run against recorded and documented answers in `packages/analytics-plausible/fixtures`; the e2e run posts to a loopback Plausible and checks what arrived.

### Retention and alerting

Mycel keeps no delivery history. What exists about one intent: the outbox row, kept like every outbox event for 30 days after processing; the claim, a rate-limit window the hourly sweep removes after a day; and one log line. The worker also counts each transport answer in `mycel_analytics_deliveries_total{outcome}` on its metrics endpoint, without site, URL or payload. Alert on a rising `unknown` (Plausible slow or failing after receipt) or `rejected` (a site identifier Plausible does not know, which the admin shows as a mismatch); the log line names the tenant and event id to follow up.

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
