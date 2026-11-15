// A campaign placed elsewhere (ADR 033 rule 4): a reference, never a copy. Title, lead, image,
// state and counter come from the campaign's landing page and participation when the host is
// read (`campaigns/card.ts`), so a scheduled host shows what the campaign shows then. `full` may
// carry the campaign's form, only while participation is open. In a file of its own because the
// registry file stands at its size ceiling; the enums are declared here against the registry's
// types so no value import runs in a circle. Rejected: copying the title or the count into the
// block (they would drift from the landing page) and following the host's revision pin.
import { z } from 'zod';
import type { BlockDefinition, WIDTHS } from '../block-types.js';
import { EXAMPLE_IDS } from './example-ids.js';

export const CAMPAIGN_CARD_VARIANTS = ['compact', 'full'] as const;
const CARD_WIDTHS: typeof WIDTHS = ['content', 'wide', 'full'];

export const CampaignCardProps = z
  .object({
    campaignId: z.string().guid(),
    variant: z.enum(CAMPAIGN_CARD_VARIANTS).default('compact'),
    width: z.enum(CARD_WIDTHS).default('content'),
  })
  .strict();

export const campaignCardDefinition: BlockDefinition<typeof CampaignCardProps, 1> = {
  version: 1,
  props: CampaignCardProps,
  fields: [
    { key: 'campaignId', kind: 'reference', to: 'campaign' },
    { key: 'variant', kind: 'choice', options: CAMPAIGN_CARD_VARIANTS },
    { key: 'width', kind: 'choice', options: CARD_WIDTHS },
  ],
  variants: { variant: CAMPAIGN_CARD_VARIANTS, width: CARD_WIDTHS },
  localized: () => [],
  references: (p) => [{ type: 'campaign', refId: p.campaignId }],
  examples: [
    { name: 'campaign-card-compact', props: { campaignId: EXAMPLE_IDS.campaign } },
    {
      name: 'campaign-card-full-wide',
      props: { campaignId: EXAMPLE_IDS.campaign, variant: 'full', width: 'wide' },
    },
    {
      name: 'campaign-card-compact-full',
      props: { campaignId: EXAMPLE_IDS.campaign, width: 'full' },
    },
  ],
};
