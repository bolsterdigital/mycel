// Keep the CTA's editor and renderer fixtures together, including the two-action labels
// and the width between the reading column and the grid.
import type { z } from 'zod';
import type { BlockAction } from '../block-types.js';

type Action = z.infer<typeof BlockAction>;

export const ctaExamples = (signUp: Action, longLabel: Action, readMore: Action) => [
  {
    name: 'cta-band',
    props: {
      title: { nl: 'Doe mee', en: 'Join in' },
      body: { nl: 'Elke handtekening telt.', en: 'Every signature counts.' },
      actions: [signUp],
    },
  },
  {
    name: 'cta-card-two-actions',
    props: {
      variant: 'card' as const,
      title: { nl: 'Steun ons werk', en: 'Support our work' },
      actions: [signUp, longLabel],
      width: 'wide' as const,
      align: 'center' as const,
    },
  },
  {
    name: 'cta-highlight-intermediate',
    props: {
      variant: 'highlight' as const,
      title: { nl: 'Sluit je aan', en: 'Become a member' },
      actions: [signUp, longLabel],
      width: 'intermediate' as const,
      align: 'center' as const,
    },
  },
  {
    name: 'cta-full-end',
    props: {
      title: { nl: 'Lees verder', en: 'Read on' },
      actions: [readMore],
      width: 'full' as const,
      align: 'end' as const,
    },
  },
];
