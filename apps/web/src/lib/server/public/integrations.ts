// The public side of managed integrations (docs/reference/integrations.md § Where integrations
// run). The published content route describes the response it is about to send and the blocks it
// renders, the pre-footer's included; core's `integrationDecision` says what may run there; only
// that reaches the page and its CSP. This PR places the video embeds: the page gets their ids
// (`placeEmbeds`) and the response a `frame-src` with exactly their players' origins, set in
// `hooks.server.ts` from `locals.frameSources`. The tag manager waits for the consent PR.
//
// The placement is read once per request like the tracker, and it is part of the item's ETag
// (`loadPublicItem`), so switching a provider off is not hidden behind a 304. Only `[...path]`
// asks: every other public route has no published item and places nothing.
// Rejected: a gate in the shared layout, for the reason analytics.ts gives.

import {
  INTEGRATIONS,
  anonymousPrincipal,
  integrationDecision,
  useCases,
  type EmbedId,
  type IntegrationPlacement,
  type PublishedItem,
} from '@mycel/core';
import type { RenderBlock } from '#lib/blocks/model.js';
import { runtime } from '../runtime.js';
import { siteTenant, type Site } from '../site.js';
import { publishedRequest, type PublishedResponse } from './analytics.js';

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

/** The embeds a page places and the frame origins its response allows for them. */
export interface EmbedPlacement {
  embeds: EmbedId[];
  frameSources: string[];
}

const NONE: EmbedPlacement = { embeds: [], frameSources: [] };

/** The embeds this response places among `blocks` (the item's and the pre-footer's). */
export async function embedPlacement(
  site: Site,
  response: PublishedResponse,
  item: Pick<PublishedItem, 'type' | 'slug' | 'access'>,
  locale: string,
  blocks: readonly RenderBlock[]
): Promise<EmbedPlacement> {
  const placement = await sitePlacement(site);
  if (placement.embeds.length === 0) return NONE;
  const decision = integrationDecision(
    publishedRequest(site, response, item, locale),
    {
      blockTypes: blocks.map((block) => block.type),
      embeds: blocks.flatMap((block) => (block.type === 'video-embed' ? [block.provider] : [])),
    },
    placement
  );
  if (!decision.placed || decision.embeds.length === 0) return NONE;
  return {
    embeds: decision.embeds,
    frameSources: [...new Set(decision.embeds.flatMap((id) => INTEGRATIONS[id].csp.frame))],
  };
}
