// Share class-free image placement attributes between public rendering and the admin preview.
// Static CSS translates decimal digits to percentages because the CSP disallows style attributes.
// The fit names the choice, not the CSS: `cover` is a manual point, `contain` the whole image an
// editor asked for, `auto` no choice at all. Every frame shows an `auto` image whole, except a
// card, whose image area fills around the focal point (image-framing.css). Rejected: `contain`
// for both, which cannot tell an editor's choice from its absence and left bars in every card.
import type { ImageFraming, ImagePlacement, StoredMediaFocal } from '@mycel/core';

type Axis = 'x' | 'y';
type Variant = '' | '-narrow' | '-wide';
type Position = `data-frame-${Axis}${Variant}`;
type Fit = `data-frame-fit${Variant}`;

export function framingAttributes(
  placement: ImagePlacement | undefined,
  focal: StoredMediaFocal
): Partial<Record<Position | Fit, string>> {
  const attributes: Partial<Record<Position | Fit, string>> = {};
  const add = (variant: Variant, frame: ImageFraming | undefined) => {
    if (!frame) return;
    attributes[`data-frame-fit${variant}`] =
      frame.mode === 'manual' ? 'cover' : frame.mode === 'full' ? 'contain' : 'auto';
    if (frame.mode !== 'manual') return;
    for (const axis of ['x', 'y'] as const)
      attributes[`data-frame-${axis}${variant}`] = String(
        Math.round(frame.point[axis] * 100)
      ).padStart(2, '0');
  };
  add('', placement?.framing ?? (focal.mode === 'auto' ? { mode: 'auto' } : undefined));
  add('-narrow', placement?.narrow);
  add('-wide', placement?.wide);
  return attributes;
}
