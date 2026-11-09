// Image slots refer to both the asset and an optional maker, so validation and usage tracking
// share the same list. Rejected: validating the picker only in its web form.
import type { MediaCredit } from '../../media/model.js';
import type { PropReference } from '../block-types.js';

export const imageRefs = (image: {
  mediaId: string;
  credit?: MediaCredit | undefined;
}): PropReference[] => [
  { type: 'media', refId: image.mediaId },
  ...(image.credit?.photographerPersonId
    ? [{ type: 'person' as const, refId: image.credit.photographerPersonId }]
    : []),
];
