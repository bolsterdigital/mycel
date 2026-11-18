// The privacy boundary of optional measurement (docs/reference/analytics.md): one
// tenant setting, one closed event catalogue and one delivery shape, shared by the public script
// gate and the server events so neither can grow a field the other does not know. Plausible is the
// only provider; the setting names a Plausible site, never a URL Mycel fetches or puts in a CSP.
// Rejected: a free `Record<string, unknown>` of event props (an editor or a later caller could
// pass a form value or an address through it), and a script URL or tag snippet as the setting
// (a tenant would then choose what runs on the public site, which is the reviewed
// managed-integration route of ADR 022 and 024).

import { z } from 'zod';

/**
 * A Plausible site identifier, such as `example.org` or `campaign.example.org`: lower-case
 * labels of letters, digits and inner hyphens joined by dots, at least two labels, at most 253
 * characters. No scheme, port, path, query, user info or whitespace, so the value can never be
 * read as a place to fetch from. Surrounding whitespace is trimmed and upper case is folded before
 * the check, so a pasted `Example.org ` is accepted as `example.org`.
 */
export const PlausibleDomain = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'analytics.domain.invalid'
  );

/**
 * What a site decides about measurement: the Plausible site its counts go to, or null for none
 * (the default). Null stops every pageview script and server event of the site from the next
 * request on; it does not erase what Plausible already holds.
 */
export const AnalyticsSettings = z.object({ plausibleDomain: PlausibleDomain.nullable() }).strict();
export type AnalyticsSettings = z.infer<typeof AnalyticsSettings>;
export const DEFAULT_ANALYTICS: AnalyticsSettings = { plausibleDomain: null };

/**
 * The closed v1 catalogue of server events (docs/reference/analytics.md § Server events). Each entry states why
 * it exists, the only props it may carry and how long Mycel keeps anything about it. A name that
 * is not here cannot reach the `Analytics` port: `AnalyticsEvent` is built from this object.
 *
 * `form.submitted` counts an accepted public signup once, by form kind only. `form.confirmed` is
 * absent on purpose: a consent confirmation is not a conversion. `donation.paid` is reserved in
 * `RESERVED_ANALYTICS_EVENTS` and is not deliverable until the owned ledger emits it once per paid
 * payment, with no amount, donor, mandate or provider reference.
 */
export const ANALYTICS_EVENTS = {
  'form.submitted': {
    purpose: 'Count accepted public signups by form kind; no form id, label or answer.',
    props: ['kind'],
    retention: 'The outbox lifecycle of the source event (30 days after processing); no own copy.',
  },
} as const satisfies Record<
  string,
  { purpose: string; props: readonly string[]; retention: string }
>;

/** Events named in the brief that are not deliverable yet; `checkAnalyticsEvent` refuses them. */
export const RESERVED_ANALYTICS_EVENTS = ['donation.paid'] as const;

/**
 * One deliverable event: its catalogue name and its fixed, typed props. Every member is a closed
 * object, so a caller cannot add a field; `AnalyticsEvent.parse` is the check at the port.
 */
export const AnalyticsEvent = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('form.submitted'),
      props: z.object({ kind: z.literal('signup') }).strict(),
    })
    .strict(),
]);
export type AnalyticsEvent = z.infer<typeof AnalyticsEvent>;

/**
 * What the transport receives, and nothing else: the validated site identifier, the site root as
 * a queryless URL built with `siteUrl` (`https://<primary>/`, or `<origin>/<slug>` where sites are
 * addressed by slug), and the catalogue event. No request, header, principal,
 * supporter, submission or form value travels with it, and no visitor IP or user agent is
 * forwarded: a server event is a count, never a visitor.
 */
export const AnalyticsDelivery = z
  .object({
    domain: PlausibleDomain,
    url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === 'https:' || url.protocol === 'http:') &&
          /^\/(?:[a-z0-9][a-z0-9-]*)?$/.test(url.pathname) &&
          !url.search &&
          !url.hash &&
          !url.username &&
          !url.password &&
          !value.includes('?') &&
          !value.includes('#')
        );
      }, 'analytics.url.not-site-root'),
    event: AnalyticsEvent,
  })
  .strict();
export type AnalyticsDelivery = z.infer<typeof AnalyticsDelivery>;
