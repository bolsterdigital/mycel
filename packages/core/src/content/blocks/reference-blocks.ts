// The blocks that show other tenant data read when the host page is (a campaign card, an
// overview), as one group the registry spreads in. A file of its own so `block-types.ts`, at its
// size ceiling, gains one line for the group instead of one per type. Rejected: raising the
// ceiling for each new type.
import { campaignCardDefinition } from './campaign-card.js';
import { overviewDefinition } from './overview.js';
import { videoDefinition } from './video.js';

export const REFERENCE_BLOCKS = {
  'campaign-card': campaignCardDefinition,
  overview: overviewDefinition,
  video: videoDefinition,
} as const;
