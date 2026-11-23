// One set of form fields for all three uses. A posted selection is applied only to the image
// whose preview supplied it, so replacing an image never carries across an old crop.
import { ImagePlacement, UseCaseError, type ImageFraming } from '@mycel/core';

export function placementValues(
  name: string,
  placement: ImagePlacement | undefined
): Record<string, string> {
  const values: Record<string, string> = {};
  if (!placement) return values;
  values[`${name}.mediaId`] = placement.mediaId;
  for (const slot of ['framing', 'narrow', 'wide'] as const) {
    const frame = placement[slot];
    if (!frame) continue;
    const key = `${name}.${slot}`;
    values[`${key}.mode`] = frame.mode;
    if (frame.mode === 'manual') {
      values[`${key}.x`] = String(frame.point.x * 100);
      values[`${key}.y`] = String(frame.point.y * 100);
    }
  }
  return values;
}

export function framingFrom(read: (key: string) => string, key: string): ImageFraming | undefined {
  const mode = read(`${key}.mode`);
  if (mode === 'auto' || mode === 'full') return { mode };
  if (mode === 'manual') {
    const coord = (axis: string) => {
      const raw = read(`${key}.${axis}`);
      return raw.trim() ? Number(raw) / 100 : NaN;
    };
    return { mode, point: { x: coord('x'), y: coord('y') } };
  }
  return undefined;
}

export function placementFrom(
  read: (key: string) => string,
  name: string,
  imageId: string | undefined,
  previous: ImagePlacement | undefined
): ImagePlacement | undefined {
  if (read(`${name}.shown`) !== 'on') return previous?.mediaId === imageId ? previous : undefined;
  if (!imageId || read(`${name}.mediaId`) !== imageId || read(`${name}.reset`) === 'on')
    return undefined;
  const framing = framingFrom(read, `${name}.framing`);
  const narrow = framingFrom(read, `${name}.narrow`);
  const wide = framingFrom(read, `${name}.wide`);
  if (!(framing || narrow || wide)) return undefined;
  const placement = ImagePlacement.safeParse({ mediaId: imageId, framing, narrow, wide });
  if (!placement.success)
    throw new UseCaseError('invalid_input', 'invalid image placement', [
      { path: name, message: 'content.image.placement-invalid' },
    ]);
  return placement.data;
}
