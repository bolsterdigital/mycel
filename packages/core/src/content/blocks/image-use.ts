// The image block and the video poster use the same alt-text rules, so choosing an image
// for a poster participates in the same media references and readiness checks.
import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import { MediaCredit } from '../../media/model.js';

const CaptionText = z.string().max(2000);

/**
 * The use of one image: the media id plus what belongs to this use and not to the file (alt,
 * decorative, caption and credit overrides; docs/reference/media.md). An absent caption or credit
 * inherits the asset's; an empty caption string hides it in that locale.
 */
export const IMAGE_USE = {
  mediaId: z.string().guid(),
  decorative: z.boolean(),
  alt: localized(z.string().min(1).max(1000).regex(/\S/, 'content.image.alt-empty')).nullable(),
  caption: localized(CaptionText).optional(),
  credit: MediaCredit.optional(),
};
// Not decorative with `alt: null` is "alt missing" (ADR 020 rule 3, 2026-11-22): valid, a warning.
export function altRule(p: { decorative: boolean; alt: unknown }, ctx: z.RefinementCtx) {
  if (p.decorative && p.alt !== null)
    ctx.addIssue({ code: 'custom', path: ['alt'], message: 'content.image.decorative-alt' });
}
