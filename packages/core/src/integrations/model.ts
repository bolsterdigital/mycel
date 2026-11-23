// Managed site integrations (ADR 022 rules 5-7, docs/reference/integrations.md): the closed
// catalogue of external code a public page may load, and the one tenant setting that switches
// catalogue entries on. Being in this catalogue is the platform maintainer's review: each manifest
// names its owner, vendor, purpose, consent, the exact origins it needs per CSP direction, where it
// may run and what remains without it. A tenant administrator only switches an entry on or off and
// fills its validated parameters; no field takes an origin, a URL, a script or markup.
// Rejected: a tenant-supplied list of origins or a raw snippet (whoever sets it decides what runs
// on the public site, ADR 022 rule 1), and one manifest per tag inside the container (a tag
// manager's container is changed outside Mycel; what Mycel controls is which vendors' origins the
// page lets it reach, so those are a closed list of their own).

import { z } from 'zod';

/** Where a response may send or load something from, per CSP direction. Exact origins, no wildcard. */
export interface CspSources {
  script: readonly string[];
  connect: readonly string[];
  img: readonly string[];
  frame: readonly string[];
}

const sources = (partial: Partial<CspSources>): CspSources => ({
  script: partial.script ?? [],
  connect: partial.connect ?? [],
  img: partial.img ?? [],
  frame: partial.frame ?? [],
});

/**
 * When an integration may load. `click`: the visitor's click on that one embed is the consent, so
 * nothing loads before it. `analytics` and `marketing`: the site's own consent choice for that
 * category, given before any request to the integration's origins.
 */
export const CONSENT_CATEGORIES = ['analytics', 'marketing'] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];
export type IntegrationConsent = 'click' | ConsentCategory;

/**
 * Where an integration may run, on top of the published-public rule every integration shares
 * (`integrationDecision`). `public-content`: any eligible page. `public-content-without-input`: not
 * on a page where a visitor types personal data (a form, a signup, a campaign card, a reader
 * sign-in), because a tag manager's tags can read whatever the page shows and holds (ADR 022 rule 6).
 */
export type IntegrationRoutes = 'public-content' | 'public-content-without-input';

/**
 * Block types through which a visitor enters personal data on a public page. A `campaign-card`
 * counts as a whole type: its `full` variant carries the petition or fundraiser form, and the
 * decision reads block types only, never props (a card that later gains a form must not open a
 * page to tags). Rejected: deciding per variant, which would tie the consent rule to block props.
 */
export const PERSONAL_INPUT_BLOCKS: readonly string[] = [
  'form',
  'signup-form',
  'paywall',
  'campaign-card',
];

/** The fields every manifest declares (ADR 022 rule 6). Text is English reference text; the admin shows its own copy. */
export interface IntegrationManifest {
  /** Bumped when anything below changes, so a review record can name what it approved. */
  version: number;
  kind: 'embed' | 'tag-manager';
  /** The product name as the vendor writes it. */
  name: string;
  vendor: string;
  owner: string;
  purpose: string;
  consent: IntegrationConsent | 'per-activation';
  routes: IntegrationRoutes;
  csp: CspSources;
  fallback: string;
}

const PLATFORM_OWNER = 'Mycel platform maintainers';

/**
 * The tag vendors a tag-manager container may reach. Choosing one adds exactly its origins to the
 * CSP of the pages the tag manager runs on; a tag in the container for a vendor that is not chosen
 * is refused by the browser. Origins from the vendors' own CSP guidance, without wildcards; a tag
 * that needs another host shows up as a CSP report, not as a silent load.
 */
export const TAG_VENDORS = {
  'google-analytics': {
    name: 'Google Analytics 4',
    vendor: 'Google',
    csp: sources({
      script: ['https://www.googletagmanager.com'],
      connect: [
        'https://www.google-analytics.com',
        'https://region1.google-analytics.com',
        'https://region1.analytics.google.com',
      ],
      img: ['https://www.google-analytics.com', 'https://www.googletagmanager.com'],
    }),
  },
  'google-ads': {
    name: 'Google Ads',
    vendor: 'Google',
    csp: sources({
      script: ['https://www.googleadservices.com', 'https://googleads.g.doubleclick.net'],
      connect: ['https://www.google.com', 'https://googleads.g.doubleclick.net'],
      img: ['https://www.google.com', 'https://googleads.g.doubleclick.net'],
      frame: ['https://td.doubleclick.net'],
    }),
  },
  'meta-pixel': {
    name: 'Meta Pixel',
    vendor: 'Meta',
    csp: sources({
      script: ['https://connect.facebook.net'],
      connect: ['https://www.facebook.com', 'https://connect.facebook.net'],
      img: ['https://www.facebook.com'],
    }),
  },
  'linkedin-insight': {
    name: 'LinkedIn Insight Tag',
    vendor: 'LinkedIn',
    csp: sources({
      script: ['https://snap.licdn.com'],
      connect: ['https://px.ads.linkedin.com'],
      img: ['https://px.ads.linkedin.com'],
    }),
  },
  'tiktok-pixel': {
    name: 'TikTok Pixel',
    vendor: 'TikTok',
    csp: sources({
      script: ['https://analytics.tiktok.com'],
      connect: ['https://analytics.tiktok.com'],
      img: ['https://analytics.tiktok.com'],
    }),
  },
  'x-pixel': {
    name: 'X Pixel',
    vendor: 'X',
    csp: sources({
      script: ['https://static.ads-twitter.com'],
      connect: ['https://analytics.twitter.com'],
      img: ['https://analytics.twitter.com', 'https://t.co'],
    }),
  },
} as const satisfies Record<string, { name: string; vendor: string; csp: CspSources }>;

export type TagVendor = keyof typeof TAG_VENDORS;
export const TAG_VENDOR_IDS = Object.keys(TAG_VENDORS) as [TagVendor, ...TagVendor[]];

const BUNNY_STREAM_ORIGIN = 'https://player.mediadelivery.net';
/** Bunny issues a numeric library id and a video UUID. Only this pair enters the player path. */
export const BUNNY_STREAM_VIDEO_ID =
  /^[1-9][0-9]{0,18}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function bunnyStreamVideoUrl(id: string): string {
  return `${BUNNY_STREAM_ORIGIN}/embed/${id.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The catalogue. YouTube and Vimeo are the embeds the Dreamkit sites carry (10 of 12 sites);
 * Google Tag Manager is the one tag manager in that fleet with configured containers. A new entry
 * is a reviewed change to this object, its activation schema and the tests.
 */
export const INTEGRATIONS = {
  youtube: {
    version: 1,
    kind: 'embed',
    name: 'YouTube',
    vendor: 'Google',
    owner: PLATFORM_OWNER,
    purpose: 'Play a YouTube video in the page after the visitor clicks it.',
    consent: 'click',
    routes: 'public-content',
    // The privacy-enhanced host: no YouTube cookies until the visitor plays the video.
    csp: sources({ frame: ['https://www.youtube-nocookie.com'] }),
    fallback: 'A link to the video on YouTube, also without JavaScript or when switched off.',
  },
  vimeo: {
    version: 1,
    kind: 'embed',
    name: 'Vimeo',
    vendor: 'Vimeo',
    owner: PLATFORM_OWNER,
    purpose: 'Play a Vimeo video in the page after the visitor clicks it.',
    consent: 'click',
    routes: 'public-content',
    // Loaded with `dnt=1`, which stops Vimeo's own session tracking.
    csp: sources({ frame: ['https://player.vimeo.com'] }),
    fallback: 'A link to the video on Vimeo, also without JavaScript or when switched off.',
  },
  'bunny-stream': {
    version: 1,
    kind: 'embed',
    name: 'Bunny Stream',
    vendor: 'bunny.net',
    owner: PLATFORM_OWNER,
    purpose: 'Play a Bunny Stream video in the page after the visitor clicks it.',
    consent: 'click',
    routes: 'public-content',
    csp: sources({ frame: [BUNNY_STREAM_ORIGIN] }),
    fallback: 'A link to the Bunny player, also without JavaScript or when switched off.',
  },
  'google-tag-manager': {
    version: 1,
    kind: 'tag-manager',
    name: 'Google Tag Manager',
    vendor: 'Google',
    owner: PLATFORM_OWNER,
    purpose:
      "Load the site's own tag container after consent; it reaches only the tag vendors chosen with it.",
    consent: 'per-activation',
    routes: 'public-content-without-input',
    csp: sources({
      script: ['https://www.googletagmanager.com'],
      connect: ['https://www.googletagmanager.com'],
      img: ['https://www.googletagmanager.com'],
    }),
    fallback:
      'The page without tags: nothing loads before consent, after refusal or without JavaScript.',
  },
} as const satisfies Record<string, IntegrationManifest>;

export type IntegrationId = keyof typeof INTEGRATIONS;
export const INTEGRATION_IDS = Object.keys(INTEGRATIONS) as [IntegrationId, ...IntegrationId[]];
/** The catalogue entries that are embeds, in catalogue order. */
export const EMBED_IDS = [
  'youtube',
  'vimeo',
  'bunny-stream',
] as const satisfies readonly IntegrationId[];
export type EmbedId = (typeof EMBED_IDS)[number];

/**
 * A Google Tag Manager web container id as Google issues it, such as `GTM-ABC123`. Trimmed and
 * upper-cased first, so a pasted ` gtm-abc123` is accepted. It goes into the loader's query
 * string, never into a CSP or markup.
 */
export const GtmContainerId = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^GTM-[A-Z0-9]{4,12}$/, 'integration.gtm.container-invalid');

const EmbedActivation = z.object({ enabled: z.boolean() }).strict();

const GtmActivation = z
  .object({
    enabled: z.boolean(),
    containerId: GtmContainerId.nullable(),
    /** The consent category the container waits for. */
    category: z.enum(CONSENT_CATEGORIES),
    vendors: z
      .array(z.enum(TAG_VENDOR_IDS))
      .max(TAG_VENDOR_IDS.length)
      .refine((list) => new Set(list).size === list.length, 'integration.gtm.vendor-duplicate'),
  })
  .strict()
  .refine((value) => !value.enabled || value.containerId !== null, {
    path: ['containerId'],
    message: 'integration.gtm.container-required',
  });

/**
 * What a site switched on. Every catalogue entry is present; `enabled: false` is the kill switch
 * and keeps the entry's parameters, so switching back on needs no re-entry.
 */
export const IntegrationSettings = z
  .object({
    youtube: EmbedActivation,
    vimeo: EmbedActivation,
    'bunny-stream': EmbedActivation.default({ enabled: false }),
    'google-tag-manager': GtmActivation,
  })
  .strict();
export type IntegrationSettings = z.infer<typeof IntegrationSettings>;

export const DEFAULT_INTEGRATIONS: IntegrationSettings = {
  youtube: { enabled: false },
  vimeo: { enabled: false },
  'bunny-stream': { enabled: false },
  'google-tag-manager': {
    enabled: false,
    containerId: null,
    category: 'marketing',
    vendors: [],
  },
};

/**
 * What a public page needs to place the switched-on integrations, and nothing else: which embeds
 * are on, and the tag manager's container, consent category and chosen vendors. All of it is
 * visible in a page that uses it anyway (the loader's query, the CSP header).
 */
export const IntegrationPlacement = z
  .object({
    embeds: z.array(z.enum(EMBED_IDS)),
    tagManager: z
      .object({
        containerId: GtmContainerId,
        category: z.enum(CONSENT_CATEGORIES),
        vendors: z.array(z.enum(TAG_VENDOR_IDS)),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type IntegrationPlacement = z.infer<typeof IntegrationPlacement>;

/** The placement of a setting: switched-on entries only. */
export function placementOf(settings: IntegrationSettings): IntegrationPlacement {
  const gtm = settings['google-tag-manager'];
  return {
    embeds: EMBED_IDS.filter((id) => settings[id].enabled),
    tagManager:
      gtm.enabled && gtm.containerId !== null
        ? { containerId: gtm.containerId, category: gtm.category, vendors: [...gtm.vendors] }
        : null,
  };
}
