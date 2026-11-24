// A crop belongs to one use of an image. Binding it to the asset prevents a choice for
// a replaced image from being applied to its replacement, including through fallback chains.
import { z } from 'zod';
import { MediaFocal } from './model.js';

export const ImageFraming = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('auto') }),
  z.strictObject({ mode: z.literal('full') }),
  z.strictObject({ mode: z.literal('manual'), point: MediaFocal }),
]);
export type ImageFraming = z.infer<typeof ImageFraming>;

export const ImagePlacement = z
  .strictObject({
    mediaId: z.string().guid(),
    framing: ImageFraming.optional(),
    narrow: ImageFraming.optional(),
    wide: ImageFraming.optional(),
  })
  .refine(({ framing, narrow, wide }) => Boolean(framing || narrow || wide));
export type ImagePlacement = z.infer<typeof ImagePlacement>;

export function placementFor(
  placement: ImagePlacement | undefined,
  mediaId: string | null | undefined
): ImagePlacement | undefined {
  return placement?.mediaId === mediaId ? placement : undefined;
}
