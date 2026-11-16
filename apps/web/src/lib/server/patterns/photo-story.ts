// The photos of a new photo story, as `content/new` asks for them: a fixed number of slots, each an
// image of the site with a description per chosen locale or "decorative". Core's factory builds the
// blocks; this module only reads the form and says what is missing, so the form can come back with
// one sentence instead of a refusal from the schema.
//
// Rejected: a separate page that picks the photos after the item exists, which would leave an
// empty article behind when the editor stops halfway; and inheriting alt text from the file,
// which Mycel does not keep (alt belongs to the use of an image, docs/reference/media.md).
import type { StoryPhoto } from '@mycel/core';
import type { FormValues } from '#lib/server/content/content-admin.js';

/** How many photos the form asks for; the editor adds more in the item itself. */
export const PHOTO_SLOTS = 3;

/** Why the photos cannot make a story yet; null when they can. */
export type PhotoProblem = 'none' | 'alt' | null;

const text = (values: FormValues, key: string): string => {
  const v = values[key];
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * The chosen photos in slot order, each with its description in every one of `locales` or marked
 * decorative. `problem` is `none` without any photo and `alt` when a chosen photo lacks a
 * description in one of `locales`; the photos are only fit for the factory when it is null.
 */
export function storyPhotos(
  values: FormValues,
  locales: readonly string[]
): { photos: StoryPhoto[]; problem: PhotoProblem } {
  const photos: StoryPhoto[] = [];
  let problem: PhotoProblem = null;
  for (let n = 0; n < PHOTO_SLOTS; n++) {
    const mediaId = text(values, `photo.${n}.mediaId`);
    if (!mediaId) continue;
    const decorative = text(values, `photo.${n}.decorative`) !== '';
    const alt = Object.fromEntries(
      locales.flatMap((l) =>
        text(values, `photo.${n}.alt.${l}`) ? [[l, text(values, `photo.${n}.alt.${l}`)]] : []
      )
    );
    if (!decorative && Object.keys(alt).length < locales.length) problem = 'alt';
    photos.push({ mediaId, decorative, alt: decorative ? null : alt });
  }
  return { photos, problem: photos.length ? problem : 'none' };
}
