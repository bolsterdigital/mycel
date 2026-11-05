// What a media list can ask beyond a kind and a search: whether a file is used, whether one of its
// uses still lacks alt text, an order and a position. The library in the admin and an agent ask the
// same questions, so they are fields of `media.list`, and the rules live here once: the memory
// adapter runs these functions as written, the Postgres adapter states the same rules in SQL, and
// one scenario in `packages/db/src/adapter-rules.test.ts` holds the two to one answer.
//
// "Unused" means no row in `media_usages`, old revisions and site settings included: exactly what
// lets `media.delete` go ahead, and what the count on the page says. Rejected: only the latest
// revisions, which would offer files for deletion that the delete then refuses.
//
// Alt text belongs to the use of an image, not to the file (`media/model.ts`), so "alt missing" is
// a question about the latest revisions that use the file: a use that is not decorative and has no
// text in one of its document's locales. A hero without `heroAlt` is decorative by definition (ADR
// 025). A featured or share image has no alt to miss. In SQL it is one statement that reads each
// latest revision once, so `statement_timeout` bounds it and it holds no connection across a walk
// (the trouble of a walk like the translation filter's); it runs only while the filter is on, and the plain
// library reads no document. Rejected: a flag per use written at save, which needs a backfill and
// a second copy of the answer, and a walk in core over each page's assets, which cannot count or
// page what it filters.

import { z } from 'zod';
import type { ContentDocument } from '../content/model.js';
import type { MediaKind, MediaRecord } from './model.js';

export const MediaSort = z.enum(['created', 'name', 'size']);
export type MediaSort = z.infer<typeof MediaSort>;

export const MediaSortDirection = z.enum(['asc', 'desc']);
export type MediaSortDirection = z.infer<typeof MediaSortDirection>;

/** Newest and largest first, A to Z for names. */
export const defaultMediaDirection = (by: MediaSort): MediaSortDirection =>
  by === 'name' ? 'asc' : 'desc';

export interface MediaFilter {
  kind?: MediaKind | undefined;
  /** Case-insensitive substring of the filename or of the caption in any locale. */
  q?: string | undefined;
  /** No usage anywhere (true), or at least one (false). */
  unused?: boolean | undefined;
  /** A use in a latest revision lacks alt text (true), or none does (false). */
  missingAlt?: boolean | undefined;
}

export interface MediaOrder {
  by: MediaSort;
  direction: MediaSortDirection;
}

const names = new Intl.Collator('und');

/**
 * Orders two assets: negative when `a` comes first. Ties fall to the id in the same direction, so
 * every order is total and a position in it is stable.
 */
export function compareMedia({
  by,
  direction,
}: MediaOrder): (a: MediaRecord, b: MediaRecord) => number {
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const first =
      by === 'name'
        ? names.compare(a.filename, b.filename)
        : by === 'size'
          ? a.sizeBytes - b.sizeBytes
          : a.createdAt.getTime() - b.createdAt.getTime();
    return sign * (first || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  };
}

/**
 * Every use of an image anywhere under `value`, nested blocks included: an object naming a media id
 * and whether it is decorative. That shape is the one image use of every block type, which the
 * block conformance suite holds, so a new block needs no entry here.
 */
export function imageUsesIn(
  value: unknown
): { mediaId: string; decorative: boolean; alt: unknown }[] {
  if (Array.isArray(value)) return value.flatMap(imageUsesIn);
  if (typeof value !== 'object' || value === null) return [];
  const fields = value as Record<string, unknown>;
  const { mediaId, decorative, alt } = fields;
  const here =
    typeof mediaId === 'string' && typeof decorative === 'boolean'
      ? [{ mediaId, decorative, alt }]
      : [];
  return [...here, ...Object.values(fields).flatMap(imageUsesIn)];
}

/** The media ids this document uses without alt text in one of its locales. */
export function mediaMissingAlt(doc: ContentDocument): string[] {
  const lacks = (alt: unknown) =>
    doc.locales.some((locale) => !(alt as Record<string, unknown> | null)?.[locale]);
  const ids = imageUsesIn(doc.blocks)
    .filter((use) => !use.decorative && lacks(use.alt))
    .map((use) => use.mediaId);
  if (doc.heroImageId && doc.heroAlt && lacks(doc.heroAlt)) ids.push(doc.heroImageId);
  return [...new Set(ids)];
}
