// Blocks that point to related content via a tenant reference or a public permalink, as one
// group the registry spreads in. A file of its own so `block-types.ts`, at its
// size ceiling, gains one line for the group instead of one per type. Rejected: raising the
// ceiling for each new type.
import { campaignCardDefinition } from './campaign-card.js';
import { socialConversationDefinition } from './social-conversation.js';
import { overviewDefinition } from './overview.js';

export const REFERENCE_BLOCKS = {
  'campaign-card': campaignCardDefinition,
  'social-conversation': socialConversationDefinition,
  overview: overviewDefinition,
} as const;
