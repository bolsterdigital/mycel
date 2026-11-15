// What the edit screen needs to show and choose the references of its blocks: the form choices
// and definitions (`forms/editor.ts`) and the campaigns (ADR 033 rule 4). A campaign card shows
// the campaign as the site would show it now in the screen's locale, or why it shows nothing, so
// the editor sees a draft or archived target before publishing the host. The choices are the
// site's own campaigns that are not archived, by their landing page's title; `campaign.list`
// reads under the site's RLS, so another tenant's campaign can never be offered. Rejected: the
// lookups inline in the edit route (it stands at its size ceiling) and offering archived
// campaigns (archiving removes a campaign from card selection, rule 9).
import {
  can,
  MAX_PAGE_SIZE,
  pick,
  useCases,
  type Block,
  type CampaignCard,
  type Principal,
} from '@mycel/core';
import { runtime } from '../runtime.js';
import { editorForms } from '../forms/editor.js';
import { textRestOf } from './content-blocks.js';

export async function editorCampaigns(
  principal: Principal,
  blocks: readonly Block[],
  locale: string,
  fallback: string
) {
  const { invoker } = runtime();
  const cards = new Map<string, CampaignCard>();
  for (const b of blocks)
    if (b.type === 'campaign-card' && !cards.has(b.props.campaignId))
      cards.set(
        b.props.campaignId,
        await invoker.run(useCases.getCampaignCard, principal, {
          campaignId: b.props.campaignId,
          locale,
        })
      );
  if (!can(principal, 'content:write')) return { cards, choices: null };
  const { campaigns } = await invoker.run(useCases.listCampaigns, principal, {
    limit: MAX_PAGE_SIZE,
  });
  return {
    cards,
    choices: campaigns.map((c) => ({
      id: c.id,
      label: (c.landing && pick(c.landing.title, locale, fallback)) || c.landing?.slug || c.id,
    })),
  };
}

/** Forms and campaigns together, and the rest view of a text block that uses them. */
export async function editorReferences(
  principal: Principal,
  blocks: readonly Block[],
  locale: string,
  fallback: string
) {
  const forms = await editorForms(principal, blocks, locale, fallback);
  const campaigns = await editorCampaigns(principal, blocks, locale, fallback);
  return {
    forms,
    campaigns,
    rest: (b: Block, prefix: string) =>
      textRestOf(b, locale, prefix, forms.definitions, fallback, campaigns.cards),
  };
}
