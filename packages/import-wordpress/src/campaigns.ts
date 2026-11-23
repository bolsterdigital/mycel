// Dreamkit campaigns (MY-291, ADR 033): a post of type `petition`, `signup` or `fundraiser` is one
// action. Its content becomes the landing page and the action a campaign bound to it; a
// `wings/campaign-card` anywhere becomes a live reference to that campaign, so two pages that show
// one action show one campaign. What WXR holds comes over: copy, status, goal and the starting
// count (`_campaign_count_offset`). What it does not hold stays with its source and is reported
// per action: the Gravity Forms form, the participations and gifts behind the count, and the
// confirmation policy the bound form must repeat. So an imported campaign has no form and stays a
// draft: it cannot take part until an editor binds a form and opens it, and an import sends no
// mail, records no consent and starts no payment. Rejected: opening a campaign whose source was
// open (without a form `campaign.open` refuses, and a half-made action that takes signatures is
// worse than a closed one) and adding the stored signature count to the starting count (the
// source's administration owns that number; the briefing keeps history at its source).

import type { WxrPost } from './wxr.js';

export const CAMPAIGN_TYPES = ['petition', 'signup', 'fundraiser'] as const;
export type CampaignType = (typeof CAMPAIGN_TYPES)[number];
export const isCampaignType = (type: string): type is CampaignType =>
  (CAMPAIGN_TYPES as readonly string[]).includes(type);

/** Where Dreamkit served each kind (`class-post-types.php`, `rewrite.slug`). */
export const SOURCE_BASE: Record<CampaignType, string> = {
  petition: 'petitions',
  signup: 'signups',
  fundraiser: 'fundraisers',
};

/** The Mycel form kind a campaign of each kind binds (ADR 033 rule 3). */
const FORM_KIND: Record<CampaignType, string> = {
  petition: 'petition',
  signup: 'signup',
  fundraiser: 'donation',
};

export interface PlannedCampaign {
  ref: string;
  /** The WordPress post the action comes from (the default-language one). */
  sourceId: number;
  landingRef: string;
  kind: CampaignType;
  goal: { target: number; milestones: number[] } | null;
  startingCount: number;
}

export type CampaignCode =
  | 'campaign.form-missing'
  | 'campaign.history-in-source'
  | 'campaign.confirmation'
  | 'campaign.goal-milestones'
  | 'campaign.goal-invalid'
  | 'campaign.archive';

const ON = new Set(['1', 'yes', 'on', 'true']);
const OFF = new Set(['0', 'no', 'off', 'false']);
const MAX_TARGET = 1_000_000_000_000;
const MAX_STARTING = 100_000_000;

const whole = (value: string | undefined) => {
  const n = Number((value ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** One action as a campaign, with what the report must say about it. */
export function planCampaign(
  post: WxrPost,
  kind: CampaignType,
  refs: { ref: string; landingRef: string }
): { campaign: PlannedCampaign; lines: { code: CampaignCode; detail: string }[] } {
  const meta = post.meta;
  const lines: { code: CampaignCode; detail: string }[] = [];

  // A fundraiser's goal is in euros in Dreamkit and in minor units in Mycel (ADR 033 rule 8).
  const raw = whole(meta._campaign_goal);
  const target = raw === null ? null : kind === 'fundraiser' ? raw * 100 : raw;
  let goal: PlannedCampaign['goal'] = null;
  if (target !== null && target <= MAX_TARGET) goal = { target, milestones: [] };
  else if (target !== null) lines.push({ code: 'campaign.goal-invalid', detail: String(raw) });
  // With milestone goals Dreamkit rewrote `_campaign_goal` to the step it showed; the steps
  // themselves are a serialized PHP array or a default list, so the editor sets them again.
  if (ON.has((meta._use_milestone_goals ?? '').trim()))
    lines.push({ code: 'campaign.goal-milestones', detail: `goal ${raw ?? 'none'}` });

  const offset = whole(meta._campaign_count_offset);
  const startingCount =
    kind !== 'fundraiser' && offset !== null && offset <= MAX_STARTING ? offset : 0;

  const form = whole(meta._campaign_form_id);
  lines.push({
    code: 'campaign.form-missing',
    detail: `${form ? `Gravity Forms form ${form}` : 'no form'}; bind a ${FORM_KIND[kind]} form`,
  });
  const stored = whole(meta._confirmed_signatures_count);
  const donorOffset = whole(meta._campaign_donor_count_offset);
  lines.push({
    code: 'campaign.history-in-source',
    detail:
      kind === 'fundraiser'
        ? `gifts and payments${donorOffset ? `; donor count offset ${donorOffset} not used` : ''}`
        : `participations${stored ? ` (${stored} confirmed in the source)` : ''}${
            startingCount ? `; starting count ${startingCount}` : ''
          }`,
  });
  // `Wings_Campaigns_Confirmation_Policy`: a per-campaign override wins, else petitions confirm.
  if (kind !== 'fundraiser') {
    const override = (meta._wings_require_confirmation ?? '').trim().toLowerCase();
    const confirms = ON.has(override) ? true : OFF.has(override) ? false : kind === 'petition';
    lines.push({
      code: 'campaign.confirmation',
      detail: confirms ? 'source asked for confirmation' : 'source took part without confirmation',
    });
  }

  return {
    campaign: {
      ref: refs.ref,
      sourceId: post.id,
      landingRef: refs.landingRef,
      kind,
      goal,
      startingCount,
    },
    lines,
  };
}
