# Managed integrations

External code a public Mycel page may load: a video player or a tag manager. The rules are [ADR 022](../adr/022-managed-extensions-and-site-integrations.md) rules 5-7; this page says how they are built. Status: the catalogue, the tenant setting and the decision are in place; the video player and the consent banner with the tag manager loader follow.

## Who decides what

- **The catalogue is code** (`packages/core/src/integrations/model.ts`). An entry is a manifest: version, kind, name, vendor, owner, purpose, consent, routes, the exact origins it needs per CSP direction, and its fallback. Adding or changing one is a reviewed change in this repository; that review is the platform maintainer's admission (ADR 022 rule 1).
- **The tenant administrator** (`tenant:admin`) switches entries on or off and fills their parameters: `integration.settings.get|update`, audited like every command. No field takes an origin, a URL, a script or markup. Switching an entry off (`enabled: false`) is the kill switch: it stops placement from the next request on and keeps the parameters.
- **The public site** reads `integration.placement.get` (anonymous): the switched-on embeds and the tag manager's container, consent category and vendors, all of which a page that uses them shows anyway.

## The catalogue

| Entry                | Kind        | Loads after                                                             | Origins                                                                                 | Fallback              |
| -------------------- | ----------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| `youtube`            | embed       | the visitor's click on that video                                       | `frame-src https://www.youtube-nocookie.com`                                            | a link to the video   |
| `vimeo`              | embed       | the visitor's click on that video (`dnt=1`)                             | `frame-src https://player.vimeo.com`                                                    | a link to the video   |
| `google-tag-manager` | tag manager | the site's consent choice for its category (`analytics` or `marketing`) | `https://www.googletagmanager.com` for script, connect and img, plus the chosen vendors | the page without tags |

A tag manager's container is edited outside Mycel, so Mycel cannot review its tags. What it controls is which vendors' origins the page lets the container reach: Google Analytics 4, Google Ads, Meta Pixel, LinkedIn Insight Tag, TikTok Pixel and X Pixel, each with fixed origins in `TAG_VENDORS`. A tag for a vendor that is not chosen is refused by the browser and shows up as a CSP report.

## Where integrations run

`integrationDecision` (`packages/core/src/integrations/decision.ts`) decides per response, purely:

1. Only a response that `pageviewDecision` would count qualifies: a successful GET of a published `public` HTML page. Admin, preview, reader, callback, confirm, token, form-action, error and redirect responses place nothing whatever the setting says ([analytics](analytics.md) § Pageviews).
2. An embed is placed only where the page renders a video of that provider.
3. The tag manager is not placed on a page with a `form`, `signup-form` or `paywall` block: tags can read what a visitor types (ADR 022 rule 6). Measuring conversions on such pages needs its own route review first.
4. The response's CSP gains exactly the origins of what is placed, never a wildcard and never a tenant parameter.

The server never reads the visitor's consent: pages stay cacheable, and the browser applies the choice before anything loads.

## What this does not promise

The [analytics](analytics.md) promise (no cookies, no visitor profile) holds for a site without a tag manager. With one switched on, the tags in its container decide what visitors share; the admin says so beside the switch. Mycel makes no claim that a consent banner is legally sufficient or unnecessary; that review is the site operator's.

## Storage

`site_settings.integrations` (migration 0081), a versioned JSON value under the site's forced RLS, exported and imported with the site. A stored value this version cannot parse reads as everything off.
