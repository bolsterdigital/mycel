// Which switched-on integrations one public response may carry, and the CSP sources that come
// with exactly those (docs/reference/integrations.md § Where integrations run). Pure and
// framework-free, like `pageviewDecision`, whose representation rules it reuses: only a successful
// GET of a published, public HTML page qualifies, so admin, preview, reader, callback, confirm,
// token, error and redirect responses carry nothing whatever the setting says. On top of that a
// tag manager stays off a page where a visitor enters personal data, and an embed is placed only
// where the page renders a video of that provider.
// Rejected: deciding on the visitor's consent cookie here (the page would stop being cacheable
// and the server would hold a per-visitor fact; consent is applied in the browser before
// anything loads), and returning the union of all catalogue origins (a page would allow hosts it
// never uses).

import {
  pageviewDecision,
  type PageviewRefusal,
  type PageviewRequest,
} from '../analytics/eligibility.js';
import {
  INTEGRATIONS,
  PERSONAL_INPUT_BLOCKS,
  TAG_VENDORS,
  type ConsentCategory,
  type CspSources,
  type EmbedId,
  type IntegrationPlacement,
} from './model.js';

/** The page the response renders: its block types and the video providers it shows. */
export interface IntegrationPage {
  blockTypes: readonly string[];
  embeds: readonly EmbedId[];
}

export type IntegrationDecision =
  | {
      placed: true;
      /** The embeds to enhance on this page, in catalogue order. */
      embeds: EmbedId[];
      /** The tag manager to load after consent, or null. */
      tagManager: { containerId: string; category: ConsentCategory } | null;
      /** The sources to add to this response's CSP; empty lists when nothing is placed. */
      csp: CspSources;
    }
  | { placed: false; reason: PageviewRefusal | 'none' };

const merge = (lists: readonly CspSources[]): CspSources => {
  const pick = (key: keyof CspSources) => [...new Set(lists.flatMap((list) => list[key]))].sort();
  return {
    script: pick('script'),
    connect: pick('connect'),
    img: pick('img'),
    frame: pick('frame'),
  };
};

/**
 * The decision for one response. `placed: false` with `none` means the response qualified but
 * nothing switched on applies to this page; a refusal names why the response does not qualify.
 */
export function integrationDecision(
  request: PageviewRequest,
  page: IntegrationPage,
  placement: IntegrationPlacement
): IntegrationDecision {
  const eligibility = pageviewDecision(request);
  if (!eligibility.eligible) return { placed: false, reason: eligibility.reason };

  const embeds = placement.embeds.filter((id) => page.embeds.includes(id));
  const hasInput = page.blockTypes.some((type) => PERSONAL_INPUT_BLOCKS.includes(type));
  const tagManager =
    placement.tagManager && !hasInput
      ? { containerId: placement.tagManager.containerId, category: placement.tagManager.category }
      : null;
  if (embeds.length === 0 && tagManager === null) return { placed: false, reason: 'none' };

  const csp = merge([
    ...embeds.map((id) => INTEGRATIONS[id].csp),
    ...(tagManager
      ? [
          INTEGRATIONS['google-tag-manager'].csp,
          ...(placement.tagManager?.vendors ?? []).map((vendor) => TAG_VENDORS[vendor].csp),
        ]
      : []),
  ]);
  return { placed: true, embeds, tagManager, csp };
}
