// The public side of managed integrations (docs/reference/integrations.md § Where integrations
// run). The published content route describes the response it is about to send and the blocks it
// renders, the pre-footer's included; core's `integrationDecision` says what may run there; only
// that reaches the page and its CSP. Video embeds get their ids (`placeEmbeds`) and frames; a tag
// manager gets the hidden consent banner, the loader's values and its script, connect, img and
// frame origins plus the `default` Trusted Types policy, all set in `hooks.server.ts` from
// `locals.pageSources`.
//
// The placement is read once per request like the tracker, and it is part of the item's ETag
// (`loadPublicItem`), so switching an entry off is not hidden behind a 304. Only `[...path]`
// asks: every other public route has no published item and places nothing.
// Rejected: a gate in the shared layout, for the reason analytics.ts gives.

import {
  INTEGRATIONS,
  TAG_VENDORS,
  anonymousPrincipal,
  integrationDecision,
  useCases,
  type ConsentCategory,
  type EmbedId,
  type IntegrationPlacement,
  type PublishedItem,
} from '@mycel/core';
import type { RenderBlock } from '#lib/blocks/model.js';
import type { PageSources } from '#lib/server/http/security-headers.js';
import { ui } from '../../../../i18n/index.js';
import { runtime } from '../../runtime.js';
import { sitePath, siteTenant, type Site } from '../../site.js';
import { publishedRequest, type PublishedResponse } from './analytics.js';
import { CONSENT_PATH, consentCookiePath, consentHref } from './consent.js';

const placementBySite = new WeakMap<Site, Promise<IntegrationPlacement>>();

/** What the site switched on; read once per request. */
export function sitePlacement(site: Site): Promise<IntegrationPlacement> {
  let found = placementBySite.get(site);
  if (!found) {
    found = runtime().invoker.run(
      useCases.getIntegrationPlacement,
      anonymousPrincipal(siteTenant(site), ['content:read']),
      {}
    );
    placementBySite.set(site, found);
  }
  return found;
}

/** The banner and loader of a page that places a tag manager (`ConsentBanner.svelte`). */
export interface ConsentModel {
  /** The container and the category it waits for, on the loader's tag; never in the CSP. */
  container: string;
  category: ConsentCategory;
  /** The script origins the `default` Trusted Types policy lets through. */
  scripts: string[];
  cookiePath: string;
  /** The banner's form posts here without JavaScript; the choice page links back to `back`. */
  action: string;
  back: string;
  choiceHref: string;
  copy: { title: string; body: string; accept: string; necessary: string; choose: string };
}

/** What one page places: its players, the banner, and what its response adds to the CSP. */
export interface PagePlacement {
  embeds: EmbedId[];
  consent: ConsentModel | null;
  sources: PageSources | null;
}

const NONE: PagePlacement = { embeds: [], consent: null, sources: null };

/** "Google Tag Manager by Google, Meta Pixel by Meta", in the page's language. */
export function loadsText(locale: string, vendors: readonly (keyof typeof TAG_VENDORS)[]): string {
  const t = ui(locale);
  const gtm = INTEGRATIONS['google-tag-manager'];
  const names = [gtm, ...vendors.map((id) => TAG_VENDORS[id])].map((entry) =>
    t('consent.vendor').replace('{name}', entry.name).replace('{vendor}', entry.vendor)
  );
  return new Intl.ListFormat(locale, { type: 'conjunction' }).format(names);
}

/**
 * What this response places among `blocks` (the item's and the pre-footer's); `path` is the
 * address the page was asked for, where the choice page returns to.
 */
export async function pagePlacement(
  site: Site,
  response: PublishedResponse,
  item: Pick<PublishedItem, 'type' | 'slug' | 'access'>,
  locale: string,
  blocks: readonly RenderBlock[]
): Promise<PagePlacement> {
  const placement = await sitePlacement(site);
  if (placement.embeds.length === 0 && placement.tagManager === null) return NONE;
  // A managed video plays in the page itself after its press (managed-video.js, MY-305): its CDN
  // for the media and the HLS client's requests, `blob:` for the stream that client builds. Only
  // blocks the render gave a `play`, which core grants only where `bunny-stream` is on.
  const cdn = [
    ...new Set(blocks.flatMap((b) => (b.type === 'video' && b.play && b.origin ? [b.origin] : []))),
  ];
  const playback = cdn.length ? { media: ['blob:', ...cdn], connect: cdn } : null;
  const decision = integrationDecision(
    publishedRequest(site, response, item, locale),
    {
      blockTypes: blocks.map((block) => block.type),
      embeds: blocks.flatMap((block) => (block.type === 'video-embed' ? [block.provider] : [])),
    },
    placement
  );
  if (!decision.placed)
    return playback
      ? {
          ...NONE,
          sources: { script: [], img: [], frame: [], ...playback, defaultPolicy: false },
        }
      : NONE;
  const { csp, tagManager } = decision;
  const t = ui(locale);
  const path = response.url.pathname;
  const consent: ConsentModel | null = tagManager && {
    container: tagManager.containerId,
    category: tagManager.category,
    scripts: [...csp.script],
    cookiePath: consentCookiePath(site),
    action: sitePath(site, CONSENT_PATH),
    back: path,
    choiceHref: consentHref(site, path),
    copy: {
      title: t('consent.banner.title'),
      body: t('consent.banner.body').replace('{loads}', () =>
        loadsText(locale, placement.tagManager?.vendors ?? [])
      ),
      accept: t('consent.banner.accept'),
      necessary: t('consent.banner.necessary'),
      choose: t('consent.banner.choose'),
    },
  };
  return {
    embeds: decision.embeds,
    consent,
    sources: {
      ...csp,
      media: playback?.media ?? [],
      connect: [...csp.connect, ...(playback?.connect ?? [])],
      defaultPolicy: consent !== null,
    },
  };
}
