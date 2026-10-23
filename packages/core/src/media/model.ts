// Media (TODO #10, ADR 004 rule 4 and 6, ADR 018 rule 7): one register of uploaded files per
// tenant. Mycel owns the record (id, checksum, sizes, editorial fields, usages, state); the bytes
// sit behind the `BlobStore` port under keys derived from the id, and content refers to a media
// id, never to a URL of a vendor. Alt text and "decorative" are not here: they belong to the use
// of an image in a block, not to the file (fundamentcheck 2026-10-21).
//
// Rejected: a `media_variants` table (variants are derived and only exist together, so they are
// one jsonb column of the asset) and the unmodified original kept privately (a photo with the GPS
// position of a source must not survive even in a leaked backup; whoever needs the pristine file
// keeps it outside Mycel).

import { z } from 'zod';
import { Locale } from '../i18n/locale.js';

/** What `media.upload` accepts. SVG is refused on purpose: it can carry scripts. */
export const MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'application/pdf',
] as const;
export const MediaContentType = z.enum(MEDIA_CONTENT_TYPES);
export type MediaContentType = z.infer<typeof MediaContentType>;

/** Decoded upload size; the base64 body is a third larger. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Decompression bombs: a small file that decodes into billions of pixels. */
export const MAX_PIXELS = 50_000_000;

/** Fixed variant widths; never upscaled, see `variantPlan`. */
export const VARIANT_WIDTHS = [320, 640, 960, 1280, 1920] as const;
export const VARIANT_FORMATS = ['avif', 'webp'] as const;
export const THUMB_WIDTH = 160;

/**
 * How long `media.delete` waits before `media.purge` removes the files (ADR 019 rule 8, TODO
 * #29A). The delay is the window in which a backup or export that began before the delete still
 * finds the files of a row its database snapshot holds: the backup (`BACKUP_MAX_SECONDS`, half of
 * this) and `exportTenant` fail rather than finish later than that. A soft-deleted asset is
 * already invisible and no longer counts against the storage limit, so nothing else waits.
 * Rejected: versioned objects in the bucket (no such thing for `BLOB_STORE=fs`, and a restore
 * would pick a version per object) and a maintenance window without purges (the backup container
 * and the worker would have to coordinate).
 */
export const MEDIA_PURGE_DELAY_MS = 24 * 60 * 60 * 1000;

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif';
export type FileFormat = ImageFormat | 'pdf';

export const FORMAT_OF: Record<MediaContentType, FileFormat> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
};
export const CONTENT_TYPE_OF: Record<FileFormat, MediaContentType> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  pdf: 'application/pdf',
};
export const EXTENSION_OF: Record<FileFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  pdf: 'pdf',
};

export const MediaKind = z.enum(['image', 'document']);
export type MediaKind = z.infer<typeof MediaKind>;
export const MediaAccess = z.enum(['public', 'restricted']);
export type MediaAccess = z.infer<typeof MediaAccess>;
export const MediaState = z.enum(['ready', 'failed']);
export type MediaState = z.infer<typeof MediaState>;

/** Localised and allowed to be empty (an image without a caption is normal). */
export const MediaCaption = z.record(Locale, z.string().max(1000));
/** CIIIC lesson: the work and its maker, and the photographer, are two separate credits. */
export const MediaCredit = z
  .object({
    work: z.object({ title: z.string().max(300), maker: z.string().max(300) }).nullable(),
    photographer: z.string().max(300).nullable(),
  })
  .strict();
export type MediaCredit = z.infer<typeof MediaCredit>;
export const MediaFocal = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
export type MediaFocal = z.infer<typeof MediaFocal>;

export const NO_CREDIT: MediaCredit = { work: null, photographer: null };
export const CENTRE: MediaFocal = { x: 0.5, y: 0.5 };

/**
 * A stored derivative. `name` is `w<width>`, `thumb`, or `file` for a kind that is delivered as
 * it was stored (a PDF, an animated GIF); the file on the site is `<name>.<extension>`.
 */
export const StoredVariant = z.object({
  name: z.string().regex(/^(w\d{1,5}|thumb|file)$/),
  format: z.enum(['avif', 'webp', 'gif', 'pdf']),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  bytes: z.number().int().nonnegative(),
});
export type StoredVariant = z.infer<typeof StoredVariant>;

/** One row of `media` as the repository returns it. */
export interface MediaRecord {
  id: string;
  kind: MediaKind;
  contentType: MediaContentType;
  filename: string;
  checksum: string;
  sizeBytes: number;
  totalBytes: number;
  width: number | null;
  height: number | null;
  variants: StoredVariant[];
  access: MediaAccess;
  caption: Record<string, string>;
  credit: MediaCredit;
  source: string | null;
  licence: string | null;
  focal: MediaFocal;
  state: MediaState;
  /** The actor who uploaded it (ADR 009 rule 9). */
  createdBy: unknown;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  usageCount: number;
}

export type NewMedia = Omit<MediaRecord, 'usageCount' | 'deletedAt'>;

export type MediaPatch = Partial<
  Pick<MediaRecord, 'caption' | 'credit' | 'source' | 'licence' | 'focal' | 'access'>
>;

/** Variant file name on the site: `w960.avif`, `thumb.webp`, `file.pdf`. */
export const variantFile = (v: Pick<StoredVariant, 'name' | 'format'>): string =>
  `${v.name}.${EXTENSION_OF[v.format]}`;

/** Every key of one asset lives under this prefix, so an asset is one `list` away. */
export const mediaPrefix = (tenantId: string): string => `tenants/${tenantId}/media/`;
export const mediaKey = (tenantId: string, mediaId: string, file: string): string =>
  `${mediaPrefix(tenantId)}${mediaId}/${file}`;

/**
 * The private original of a raster image: the upload re-encoded at its own width without
 * metadata. A kind delivered as stored (`file`) has no separate original.
 */
export const originalFile = (m: Pick<MediaRecord, 'contentType' | 'variants'>): string | null =>
  m.variants.some((v) => v.name === 'file')
    ? null
    : `original.${EXTENSION_OF[FORMAT_OF[m.contentType]]}`;

/**
 * Every blob key of an asset: what `media.purge` deletes, and what a backup or export of a live
 * row must contain (`exportTenant`; `docker/backup/media-expected.sql` lists the same keys in SQL).
 */
export function mediaKeys(
  tenantId: string,
  m: Pick<MediaRecord, 'id' | 'contentType' | 'variants'>
): string[] {
  const original = originalFile(m);
  return [
    ...(original ? [mediaKey(tenantId, m.id, original)] : []),
    ...m.variants.map((v) => mediaKey(tenantId, m.id, variantFile(v))),
  ];
}

/**
 * Which widths to render for an image `width` pixels wide: the fixed widths below it, plus its
 * own width when it is smaller than the largest fixed width and not one of them, so a 1000 px
 * image gets w320, w640, w960 and w1000. Never upscaled. A 4000 px image stops at w1920: its
 * full resolution stays private.
 */
export function variantWidths(width: number): number[] {
  const max = VARIANT_WIDTHS[VARIANT_WIDTHS.length - 1]!;
  const fixed = VARIANT_WIDTHS.filter((w) => w <= width);
  return width < max && !fixed.includes(width as (typeof VARIANT_WIDTHS)[number])
    ? [...fixed, width]
    : fixed;
}

/** The view every front shows (`media.get`, `media.list`, upload and update). */
export const MediaView = z.object({
  id: z.string().uuid(),
  kind: MediaKind,
  contentType: MediaContentType,
  filename: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  checksum: z.string(),
  access: MediaAccess,
  caption: MediaCaption,
  credit: MediaCredit,
  source: z.string().nullable(),
  licence: z.string().nullable(),
  focal: MediaFocal,
  state: MediaState,
  usageCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  variants: z.array(
    z.object({
      name: z.string(),
      format: z.string(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
      /** Site-relative; empty for a restricted asset (a reader gets a signed path, #19). */
      path: z.string(),
    })
  ),
});
export type MediaView = z.infer<typeof MediaView>;
