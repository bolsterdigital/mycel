// "Ter publicatie aanbieden" (decided 2026-11-06): someone who may write marks one locale of an
// item as ready for a publisher. The mark sits beside the status
// (`LocaleState.review`), not in it, so ADR 012's four statuses stay as they are; publishing or
// scheduling the locale answers it, and the writer can take it back. The attention list reads the
// marks as its `review` source, for members with `content:publish`.
//
// Rejected: deriving "submitted" from a draft saved by someone without `content:publish` (every
// intermediate save of an author would ping, and an editor's own draft never would) and a new
// `LocaleStatus` (a fifth status ADR 012 would have to supersede, for what is a request to a
// person, not a state of the text).

import { z } from 'zod';
import { UseCaseError } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { requestReview, withdrawReview } from '../lifecycle.js';
import { ContentItem } from '../model.js';
import { changePublication } from '../service.js';

/** Enough for "please check the quote in paragraph two"; a longer message belongs elsewhere. */
export const REVIEW_NOTE_MAX = 1000;

const Target = z.object({ itemId: z.string().guid(), locale: Locale }).strict();
const example = { itemId: exampleId(0x1), locale: 'nl' };

export const requestContentReview = defineUseCase({
  name: 'content.review.request',
  kind: 'command',
  description:
    'Offer one locale of an item for publication, with an optional note for whoever publishes: the latest revision is what is offered. Offering again keeps the moment of the first offer and replaces the note; publishing or scheduling the locale answers the offer.',
  requires: 'content:write',
  input: Target.extend({
    note: z.string().trim().max(REVIEW_NOTE_MAX).optional(),
  }).strict(),
  output: ContentItem,
  examples: [{ input: { ...example, note: 'Ready from my side.' } }],
  handler: (ctx, { itemId, locale, note }) =>
    changePublication(ctx, itemId, locale, async (state, item) => {
      // Nothing to look at: the latest revision is already live, or already planned.
      if ([state.publishedRevisionId, state.scheduledRevisionId].includes(item.latestRevisionId))
        throw new UseCaseError('invalid_input', 'the latest revision is live or planned', [
          { path: 'locale', message: 'content.review.nothing-new' },
        ]);
      return requestReview(state, note || null, ctx.clock.now());
    }),
});

export const withdrawContentReview = defineUseCase({
  name: 'content.review.withdraw',
  kind: 'command',
  description:
    'Take back the offer for publication of one locale; the text and its status stay as they are.',
  requires: 'content:write',
  input: Target,
  output: ContentItem,
  examples: [{ input: example }],
  handler: (ctx, { itemId, locale }) =>
    changePublication(ctx, itemId, locale, async (state) => withdrawReview(state)),
});
