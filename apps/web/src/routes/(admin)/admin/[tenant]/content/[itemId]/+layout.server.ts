// The campaign a page is the landing page of (ADR 033), for the edit screen's side column and
// the shell's menu, which then marks Campaigns rather than Pages. A layout of its own, so the edit
// route stays under its size ceiling and its revisions and writer know the page is a campaign's.
// Null for an article and for a page that is no landing page, and null when the read is refused:
// the page load below answers for the item itself (404 for an id that is none, 403 without read),
// and a layout's error would replace that answer, so the campaign read is never the louder one.
// Rejected: the edit route's load (past its ceiling, scripts/gates/file-size.test.mjs), and
// repeating the page's checks here (two places to keep the same answer in step).
import { adminTimeZone } from '#lib/server/admin/admin.js';
import {
  CAMPAIGN_OUTCOMES,
  campaignOutcome,
  campaignPanel,
  isRefusal,
} from '#lib/server/admin/campaigns.js';
import { refusalOf } from '#lib/server/http/refuse.js';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ parent, locals, params, url }) => {
  const { tenant } = await parent();
  const { zone, site } = await adminTimeZone(locals);
  const panel = await campaignPanel(locals.principal!, params.itemId, zone).catch((e: unknown) => {
    refusalOf(e);
    return null;
  });
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
