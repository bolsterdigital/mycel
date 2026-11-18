// The public script gate of measurement (docs/reference/analytics.md § Pageviews). The
// published content route describes the response it is about to send; core's `pageviewDecision`
// says whether it counts and under which path; only then does the page get a tag. The tag carries
// the site's Plausible identifier, the fixed endpoint and one absolute URL built from the
// decision's path on the site's primary hostname (`siteUrls`, ADR 014 rule 6), so the request's
// own address, query, fragment and alias host never reach `static/_site/pageview.js`.
//
// Only `[...path]` asks: every other public route (confirm, reader, my-giving, donation, search,
// people, media, feeds, errors) has no published item and therefore no tag. The identifier is
// read once per request like the general settings, and it is part of the item's ETag
// (`loadPublicItem`), so switching measurement on or off is not hidden behind a 304.
// Rejected: a gate in the shared layout keyed on the route id, which would count a representation
// the layout cannot see (a restricted teaser, a failed post) unless it repeated the item's state.

import {
  PLAUSIBLE_EVENT_ENDPOINT,
  anonymousPrincipal,
  pageviewDecision,
  useCases,
  type PageviewRequest,
  type PublishedItem,
} from '@mycel/core';
import { runtime } from '../runtime.js';
import { siteTenant, siteUrls, type Site } from '../site.js';

const trackerBySite = new WeakMap<Site, Promise<string | null>>();

/** The site's Plausible identifier, or null when measurement is off; read once per request. */
export function siteTracker(site: Site): Promise<string | null> {
  let found = trackerBySite.get(site);
  if (!found) {
    found = runtime()
      .invoker.run(
        useCases.getAnalyticsTracker,
        anonymousPrincipal(siteTenant(site), ['content:read']),
        {}
      )
      .then(({ plausibleDomain }) => plausibleDomain);
    trackerBySite.set(site, found);
  }
  return found;
}

/** What `static/_site/pageview.js` reads from its tag. */
export interface PageviewTag {
  endpoint: string;
  domain: string;
  /** Absolute, on the primary hostname, with the decision's path and nothing else. */
  url: string;
}

/**
 * The tag for a published item's page, or null. `status` is the response's: the route asks
 * after the item loaded, so an error or redirect never gets here, and a failed form post is a
 * POST. A thank-you page is a form action's result and is never counted.
 */
export async function pageviewTag(
  site: Site,
  response: PublishedResponse,
  item: Pick<PublishedItem, 'type' | 'slug' | 'access'>,
  locale: string
): Promise<PageviewTag | null> {
  const domain = await siteTracker(site);
  if (domain === null) return null;
  const decision = pageviewDecision(publishedRequest(site, response, item, locale));
  if (!decision.eligible) return null;
  return { endpoint: PLAUSIBLE_EVENT_ENDPOINT, domain, url: (await siteUrls(site))(decision.path) };
}

/** The response a published item's route is about to send, as far as the route knows it. */
export interface PublishedResponse {
  method: string;
  status: number;
  url: URL;
  thanks: boolean;
}

/**
 * The response as `pageviewDecision` reads it; `integrationDecision` reads the same, so a page
 * that does not count places no integration either (integrations.ts).
 */
export function publishedRequest(
  site: Site,
  response: PublishedResponse,
  item: Pick<PublishedItem, 'type' | 'slug' | 'access'>,
  locale: string
): PageviewRequest {
  return {
    method: response.method,
    status: response.status,
    contentType: null,
    pathname: response.url.pathname,
    search: response.url.search,
    representation: response.thanks ? 'form-action' : 'published',
    published: {
      type: item.type,
      slug: item.slug,
      access: item.access === 'public' ? 'public' : 'restricted',
      locale,
      defaultLocale: site.tenant.defaultLocale,
    },
  };
}
