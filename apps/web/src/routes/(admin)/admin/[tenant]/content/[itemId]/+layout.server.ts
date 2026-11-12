// The campaign a page is the landing page of (ADR 033), for the edit screen's side column and
// the shell's menu, which then marks Campaigns rather than Pages. A layout of its own, so the edit
// route stays under its size ceiling and its revisions and writer know the page is a campaign's.
// Null for an article and for a page that is no landing page.
// Rejected: the edit route's load (past its ceiling, scripts/gates/file-size.test.mjs).
import { adminTimeZone } from '#lib/server/admin/admin.js';
import {
  CAMPAIGN_OUTCOMES,
  campaignOutcome,
  campaignPanel,
  isRefusal,
} from '#lib/server/admin/campaigns.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent, locals, params, url }) => {
  const { tenant } = await parent();
  const { zone, site } = await adminTimeZone(locals);
  const panel = await campaignPanel(locals.principal!, params.itemId, zone);
  if (!panel) return { campaign: null };
  const outcome = campaignOutcome(url.searchParams.get('campaign'));
  return {
    campaign: {
      panel,
      action: `/admin/${tenant.slug}/campaigns/${panel.id}`,
      outcome: outcome ? { copy: CAMPAIGN_OUTCOMES[outcome], refused: isRefusal(outcome) } : null,
      timeZone: zone !== site ? zone : null,
    },
  };
};
