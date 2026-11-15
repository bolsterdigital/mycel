// A demo petition, so the probe site shows a campaign card (ADR 033 rule 4) with a real count and
// a working form: made through `campaign.landing.create` like the admin's "New campaign", then its
// landing page filled, published in nl and en, and participation opened. Idempotent on the slug.
// Existing demo pages remain intact; rejected: inserting the card into a page an editor may
// already have changed (only a newly seeded page gets it), and a campaign row written directly
// (it would skip the checks the use cases make).
import type { Invoker } from '../../invoke.js';
import type { Principal } from '../../principal.js';
import { useCases } from '../../use-cases.js';
import type { BlockInput } from '../../content/blocks.js';

export const DEMO_CAMPAIGN_SLUG = 'petitie-minder-zout';

const paragraph = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
});

/**
 * The card in the demo article, right after "What we ask now", with a sentence after it as every
 * custom block there has: `full`, so it carries the petition's form while it is open.
 */
export function campaignCardBlocks(campaignId: string): BlockInput[] {
  return [
    { type: 'campaign-card', version: 1, props: { campaignId, variant: 'full', width: 'wide' } },
    {
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: paragraph('Je handtekening telt zodra je hem bevestigt via de mail die je krijgt.'),
          en: paragraph(
            'Your signature counts once you confirm it through the e-mail you receive.'
          ),
        },
      },
    },
  ];
}

export async function demoCampaign(
  invoker: Invoker,
  principal: Principal,
  imageId: string
): Promise<string> {
  const { campaigns } = await invoker.run(useCases.listCampaigns, principal, { limit: 100 });
  const found = campaigns.find((c) => c.landing?.slug === DEMO_CAMPAIGN_SLUG);
  if (found) return found.id;
  const campaign = await invoker.run(useCases.composeCampaign, principal, {
    kind: 'petition',
    title: { nl: 'Minder zout in pepernoten', en: 'Less salt in pepernoten' },
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    slug: DEMO_CAMPAIGN_SLUG,
    goal: { target: 2500, milestones: [] },
  });
  const { item, revision } = await invoker.run(useCases.getItem, principal, {
    itemId: campaign.landingItemId,
  });
  const saved = await invoker.run(useCases.updateItem, principal, {
    itemId: item.id,
    baseRevisionId: revision.id,
    document: {
      ...revision.document,
      lead: {
        nl: 'Vraag fabrikanten om het zout in pepernoten te halveren. Bakkers in de Lindewijk lieten zien dat het kan.',
        en: 'Ask manufacturers to halve the salt in pepernoten. Bakers in the Lindewijk showed it can be done.',
      },
      featuredImageId: imageId,
      blocks: [
        {
          type: 'rich-text',
          version: 1,
          props: {
            content: {
              nl: paragraph('Met 2.500 handtekeningen gaan we naar de drie grootste fabrikanten.'),
              en: paragraph('With 2,500 signatures we go to the three largest manufacturers.'),
            },
          },
        },
        ...revision.document.blocks,
      ],
    },
  });
  for (const locale of ['nl', 'en'])
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: saved.revision.id,
      locale,
    });
  await invoker.run(useCases.openCampaign, principal, {
    campaignId: campaign.id,
    baseUpdatedAt: campaign.updatedAt,
  });
  return campaign.id;
}
