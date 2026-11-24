// Demo action-row copy lives beside the other composed fixtures, not in the block registry.
// Rejected: registry examples with unresolved ids on the visitor-facing demo.
import { BLOCK_DEFINITIONS } from '../../content/block-types.js';
import type { z } from 'zod';
import type { useCases } from '../../use-cases.js';
import { block, say } from '../sites/rich.js';
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

/** The fictional project's posts at the end of the demo article. */
export function articleClosingActions(): BlockIn[] {
  return [
    say({
      nl: 'We sturen alleen die ene mail per maand, en we delen je adres met niemand.',
      en: 'We only send that one e-mail a month, and we share your address with no one.',
    }),
    block('social-conversation', {
      blueskyPost: {
        nl: 'https://bsky.app/profile/gezondetrommel.example/post/3k4duaz5vfs2b',
        en: 'https://bsky.app/profile/gezondetrommel.example/post/3k4duaz5vfs2c',
      },
      mastodonPost: {
        nl: 'https://social.example.org/@gezondetrommel/123456789',
        en: 'https://social.example.org/@gezondetrommel/123456790',
      },
    }),
    say({
      nl: 'Nieuwe reacties en vragen nemen we mee bij de volgende meting.',
      en: 'We will take new responses and questions into account in the next study.',
    }),
  ];
}
