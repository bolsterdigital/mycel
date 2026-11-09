// Demo action-row copy lives beside the other composed fixtures, not in the block registry.
// Rejected: registry examples with unresolved ids on the visitor-facing demo.
import { BLOCK_DEFINITIONS } from '../../content/block-types.js';
import type { z } from 'zod';
import type { useCases } from '../../use-cases.js';
type BlockIn = z.input<typeof useCases.createItem.input>['document']['blocks'][number];

/** Three ways to join in, in a band: the row of cards a campaign page ends on. */
export function pageWays(articleSlug: string): BlockIn {
  return {
    type: 'cards',
    version: BLOCK_DEFINITIONS.cards.version,
    props: {
      accent: 'bar',
      width: 'full',
      cards: [
        {
          title: { nl: 'Lees het onderzoek', en: 'Read the study' },
          body: {
            nl: 'Alle 48 zakken, per merk, met de cijfers van het lab.',
            en: 'All 48 bags, by brand, with the figures from the lab.',
          },
          actions: [
            {
              label: { nl: 'Naar het artikel', en: 'To the article' },
              target: { kind: 'url', url: `/articles/${articleSlug}` },
            },
          ],
        },
        {
          title: { nl: 'Meet mee', en: 'Measure with us' },
          body: {
            nl: 'Twee weken in november, een paar uur per week, in je eigen buurt.',
            en: 'Two weeks in November, a few hours a week, in your own neighbourhood.',
          },
          actions: [
            {
              label: { nl: 'Meld je aan', en: 'Sign up' },
              target: { kind: 'url', url: '/signup' },
            },
          ],
        },
        {
          title: { nl: 'Vraag het je bakker', en: 'Ask your baker' },
          body: {
            nl: 'Veertien bakkers bewezen dat de helft van het zout genoeg is.',
            en: 'Fourteen bakers proved that half the salt is enough.',
          },
        },
      ],
    },
  };
}
