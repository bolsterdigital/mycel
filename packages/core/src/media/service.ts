// Media use cases (TODO #10) and the two jobs that clean up after them. Upload is synchronous:
// probe, render every variant, check the storage cap under the tenant's media lock, write the
// files, then the row. Rendering happens before the lock, so the lock covers only the count and
// the writes; the cap is still exact, because the count and the row are under one lock.
// Rejected: processing in a job (an editor would wait on "processing" for every upload, while
// sharp renders these sizes in seconds; `state` exists so a later video flow can be asynchronous)
// and multipart over HTTP (a second contract for one use case; base64 JSON is the same over
// HTTP, MCP and the admin's server action).

import { z } from 'zod';
import { withinLimit } from '../entitlements/guards.js';
import { notFound, UseCaseError } from '../errors.js';
import '../jobs/ports.js';
import '../entitlements/ports.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { base64ToBytes } from '../util/bytes.js';
import { sha256HexOfBytes } from '../util/digest.js';
import { errorFields } from '../util/log.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { MAX_LIST_OFFSET } from '../content/listing.js';
import { defaultMediaDirection, MediaSort, MediaSortDirection } from './listing.js';
import {
  CENTRE,
  CONTENT_TYPE_OF,
  MAX_PIXELS,
  MAX_UPLOAD_BYTES,
  MEDIA_TRASH_RETENTION_MS,
  MediaAccess,
  MediaCaption,
  MediaContentType,
  MediaCredit,
  MediaFocal,
  MediaKind,
  MediaView,
  NO_CREDIT,
  THUMB_WIDTH,
  VARIANT_FORMATS,
  mediaKey,
  mediaKeys,
  mediaPrefix,
  originalFile,
  restorableUntil,
  variantFile,
  variantWidths,
  type MediaPatch,
  type MediaRecord,
  type StoredVariant,
} from './model.js';
import './ports.js';
import { exampleId } from '../util/ids.js';

const MediaId = z.string().guid();
const IsoDate = z.string().datetime({ offset: true });

/** Base64 of `MAX_UPLOAD_BYTES`, rounded up to whole quads. */
const MAX_BASE64 = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4;

/** A 1x1 PNG: the registry's example, small enough for every front's conformance run. */
export const EXAMPLE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** Orphans younger than this may belong to an upload whose transaction has not committed yet. */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

const invalid = (path: string, message: string, detail: string) =>
  new UseCaseError('invalid_input', detail, [{ path, message }]);

/** The name as uploaded, without any directory part, trimmed; control characters refused. */
const Filename = z
  .string()
  .transform((name) => (name.split(/[\\/]/).at(-1) ?? '').trim())
  .pipe(
    z
      .string()
      .min(1, 'media.filename.empty')
      .max(200, 'media.filename.too-long')
      // eslint-disable-next-line no-control-regex
      .regex(/^[^\u0000-\u001f\u007f"]+$/, 'media.filename.invalid')
  );

const Editorial = {
  caption: MediaCaption.optional(),
  credit: MediaCredit.optional(),
  source: z.string().max(500).nullable().optional(),
  licence: z.string().max(100).nullable().optional(),
  focal: MediaFocal.optional(),
  access: MediaAccess.optional(),
};

/** The view, with paths from the delivery port; a restricted variant has no public path. */
export function toMediaView(ctx: Pick<TransactionContext, 'delivery'>, m: MediaRecord): MediaView {
  return {
    id: m.id,
    kind: m.kind,
    contentType: m.contentType,
    filename: m.filename,
    width: m.width,
    height: m.height,
    sizeBytes: m.sizeBytes,
    totalBytes: m.totalBytes,
    checksum: m.checksum,
    access: m.access,
    caption: m.caption,
    credit: m.credit,
    source: m.source,
    licence: m.licence,
    focal: m.focal,
    state: m.state,
    usageCount: m.usageCount,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    variants: m.variants.map((v) => ({
      name: v.name,
      format: v.format,
      width: v.width,
      height: v.height,
      path: m.access === 'public' ? ctx.delivery.variantPath(m.id, variantFile(v)) : '',
    })),
  };
}

async function requireMedia(ctx: TransactionContext, id: string): Promise<MediaRecord> {
  const m = await ctx.media.get(id);
  if (!m || m.deletedAt) throw notFound('media');
  return m;
}

interface PreparedFile {
  file: string;
  bytes: Uint8Array;
  contentType: string;
}

interface Prepared {
  kind: MediaRecord['kind'];
  width: number | null;
  height: number | null;
  /** The stored original (or the delivered file), which checksum and size describe. */
  primary: Uint8Array;
  variants: StoredVariant[];
  files: PreparedFile[];
}

const startsWith = (bytes: Uint8Array, prefix: string) =>
  prefix.length <= bytes.length && [...prefix].every((c, i) => bytes[i] === c.charCodeAt(0));

/**
 * An ID3 tag, or an MPEG Layer III frame header with a legal version, bitrate and sample rate.
 * Delivered with `nosniff` and as `audio/mpeg`, so this only keeps a wrong file out of the library;
 * rejected: decoding the file, which would put an audio library in the core for no safer outcome.
 */
function isMp3(b: Uint8Array): boolean {
  if (startsWith(b, 'ID3')) return true;
  const [sync, flags, rates] = [b[0] ?? 0, b[1] ?? 0, b[2] ?? 0];
  return (
    sync === 0xff &&
    (flags & 0xe0) === 0xe0 &&
    (flags & 0x18) !== 0x08 &&
    (flags & 0x06) === 0x02 &&
    rates >> 4 !== 0x0f &&
    ((rates >> 2) & 0x03) !== 0x03
  );
}

/** A file kept as it came: one `file` variant, which the checksum and size describe. */
function asStored(
  kind: MediaRecord['kind'],
  format: StoredVariant['format'],
  contentType: MediaContentType,
  bytes: Uint8Array
): Prepared {
  const variant: StoredVariant = {
    name: 'file',
    format,
    width: null,
    height: null,
    bytes: bytes.length,
  };
  return {
    kind,
    width: null,
    height: null,
    primary: bytes,
    variants: [variant],
    files: [{ file: variantFile(variant), bytes, contentType }],
  };
}

/** Check what the bytes are, then render everything that will be stored. */
async function prepare(
  ctx: TransactionContext,
  contentType: MediaContentType,
  bytes: Uint8Array
): Promise<Prepared> {
  if (contentType === 'application/pdf') {
    if (!startsWith(bytes, '%PDF-'))
      throw invalid('contentType', 'media.type.mismatch', 'the file is not a PDF');
    return asStored('document', 'pdf', contentType, bytes);
  }
  if (contentType === 'audio/mpeg') {
    if (!isMp3(bytes))
      throw invalid('contentType', 'media.type.mismatch', 'the file is not an MP3');
    return asStored('audio', 'mp3', contentType, bytes);
  }

  const probe = await ctx.images.probe(bytes);
  if (!probe) throw invalid('bytes', 'media.type.unreadable', 'the image cannot be read');
  if (CONTENT_TYPE_OF[probe.format] !== contentType)
    throw invalid(
      'contentType',
      'media.type.mismatch',
      `the file is ${CONTENT_TYPE_OF[probe.format]}, not ${contentType}`
    );
  // Every frame of an animation is decoded at once (sharp's `animated`), so the frames count.
  if (probe.width * probe.height * probe.pages > MAX_PIXELS)
    throw invalid(
      'bytes',
      'media.pixels.too-many',
      `the image has more than ${MAX_PIXELS} pixels (${probe.width}x${probe.height}` +
        (probe.pages > 1 ? `, ${probe.pages} frames)` : ')')
    );

  const files: PreparedFile[] = [];
  const variants: StoredVariant[] = [];
  const add = async (name: string, format: 'avif' | 'webp' | 'gif', width: number) => {
    const out = await ctx.images.render(bytes, { width, format, stripMetadata: true });
    const variant: StoredVariant = {
      name,
      format,
      width: out.width,
      height: out.height,
      bytes: out.bytes.length,
    };
    variants.push(variant);
    files.push({
      file: variantFile(variant),
      bytes: out.bytes,
      contentType: CONTENT_TYPE_OF[format],
    });
    return out;
  };

  let primary: Uint8Array;
  let size: { width: number; height: number };
  if (probe.format === 'gif') {
    // Delivered as stored (all frames, no metadata): there is no separate private original.
    const out = await add('file', 'gif', probe.width);
    primary = out.bytes;
    size = out;
  } else {
    const original = await ctx.images.render(bytes, {
      width: probe.width,
      format: probe.format,
      stripMetadata: true,
    });
    primary = original.bytes;
    size = original;
    files.push({
      file: originalFile({ contentType, variants: [] })!,
      bytes: original.bytes,
      contentType,
    });
    for (const width of variantWidths(original.width))
      for (const format of VARIANT_FORMATS) await add(`w${width}`, format, width);
  }
  await add('thumb', 'webp', Math.min(THUMB_WIDTH, size.width));
  return { kind: 'image', width: size.width, height: size.height, primary, variants, files };
}

/** Best effort: a failure here is logged and the files are swept later by `media.orphans`. */
async function removeQuietly(ctx: TransactionContext, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await ctx.blobs.delete(keys);
  } catch (e) {
    ctx.log.warn('media: could not remove files of a failed upload', {
      files: keys.length,
      ...errorFields(e),
    });
  }
}

export const uploadMedia = defineUseCase({
  name: 'media.upload',
  kind: 'command',
  description:
    'Upload an image (JPEG, PNG, WebP, AVIF, GIF), a PDF or an MP3 as base64, up to 25 MB; images are stored without metadata, with AVIF and WebP variants; a PDF or MP3 is stored as it came, its own metadata included.',
  requires: 'media:write',
  consumes: 'media.storage_max_bytes',
  input: z
    .object({
      filename: Filename,
      contentType: z.string().min(1).max(100),
      bytes: z
        .string()
        .min(1, 'media.bytes.empty')
        .max(MAX_BASE64, 'media.size.too-large')
        .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'media.bytes.base64'),
      ...Editorial,
    })
    .strict(),
  output: MediaView,
  examples: [
    {
      input: { filename: 'pixel.png', contentType: 'image/png', bytes: EXAMPLE_PNG },
      note: 'A 1x1 PNG.',
    },
  ],
  async handler(ctx, input) {
    const type = input.contentType.trim().toLowerCase();
    if (type === 'image/svg+xml')
      throw invalid(
        'contentType',
        'media.type.svg',
        'SVG is not accepted: scripts in SVG run on the site; logos come through the theme'
      );
    const contentType = MediaContentType.safeParse(type);
    if (!contentType.success)
      throw invalid('contentType', 'media.type.unsupported', `${type} is not accepted`);
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(input.bytes);
    } catch {
      throw invalid('bytes', 'media.bytes.base64', 'bytes is not valid base64');
    }
    if (bytes.length > MAX_UPLOAD_BYTES)
      throw invalid('bytes', 'media.size.too-large', 'the file is larger than 25 MB');

    const prepared = await prepare(ctx, contentType.data, bytes);
    const totalBytes = prepared.files.reduce((n, f) => n + f.bytes.length, 0);
    const id = ctx.ids.next();
    const tenantId = ctx.principal.tenantId;

    // Under the lock, so two uploads at once cannot both take the last bytes.
    await ctx.media.lock();
    withinLimit(ctx, 'media.storage_max_bytes', await ctx.usage.storageBytes(), totalBytes);

    const written: string[] = [];
    try {
      for (const f of prepared.files) {
        const key = mediaKey(tenantId, id, f.file);
        await ctx.blobs.put(key, f.bytes, { contentType: f.contentType });
        written.push(key);
      }
      const now = ctx.clock.now();
      await ctx.media.insert({
        id,
        kind: prepared.kind,
        contentType: contentType.data,
        filename: input.filename,
        checksum: await sha256HexOfBytes(prepared.primary),
        sizeBytes: prepared.primary.length,
        totalBytes,
        width: prepared.width,
        height: prepared.height,
        variants: prepared.variants,
        access: input.access ?? 'public',
        caption: input.caption ?? {},
        credit: input.credit ?? NO_CREDIT,
        source: input.source ?? null,
        licence: input.licence ?? null,
        focal: input.focal ?? CENTRE,
        state: 'ready',
        createdBy: ctx.principal.actor,
        createdAt: now,
        updatedAt: now,
      });
    } catch (e) {
      await removeQuietly(ctx, written);
      throw e;
    }
    return toMediaView(ctx, await requireMedia(ctx, id));
  },
});

export const getMedia = defineUseCase({
  name: 'media.get',
  kind: 'query',
  description: 'Get one media item: its file details, editorial fields, variants and usage count.',
  requires: 'media:read',
  input: z.object({ id: MediaId }).strict(),
  output: MediaView,
  resource: { uriTemplate: 'mycel://media/{id}' },
  examples: [{ input: { id: exampleId(0xd001) } }],
  async handler(ctx, { id }) {
    return toMediaView(ctx, await requireMedia(ctx, id));
  },
});

export const listMedia = defineUseCase({
  name: 'media.list',
  kind: 'query',
  description:
    'List the media of this site, a page at a time, newest first unless `sort` says otherwise; `q` finds a filename or caption that contains it, `unused` a file nothing refers to, `missingAlt` an image a latest revision uses without alt text in one of its locales.',
  requires: 'media:read',
  input: z
    .object({
      kind: MediaKind.optional(),
      // A NUL is no search anyone typed, and Postgres refuses it in a parameter: a 400, not a 500.
      q: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .refine((q) => !q.includes('\0'))
        .optional(),
      unused: z.boolean().optional(),
      missingAlt: z.boolean().optional(),
      sort: MediaSort.optional(),
      direction: MediaSortDirection.optional(),
      cursor: MediaId.optional(),
      offset: z.number().int().min(0).max(MAX_LIST_OFFSET).optional(),
      /** Default 50. */
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    })
    .strict(),
  output: z.object({
    items: z.array(MediaView),
    nextCursor: MediaId.nullable(),
    /** Everything the filter matches, on every page. */
    total: z.number().int().nonnegative(),
  }),
  examples: [{ input: {} }],
  async handler(
    ctx,
    { kind, q, unused, missingAlt, sort = 'created', direction, cursor, offset, limit = 50 }
  ) {
    const filter = { kind, q, unused, missingAlt };
    const order = { by: sort, direction: direction ?? defaultMediaDirection(sort) };
    const rows = await ctx.media.list({ ...filter, order, cursor, offset, limit: limit + 1 });
    const total = await ctx.media.count(filter);
    const page = rows.slice(0, limit);
    return {
      items: page.map((m) => toMediaView(ctx, m)),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
      total,
    };
  },
});

export const updateMedia = defineUseCase({
  name: 'media.update',
  kind: 'command',
  description:
    'Change the caption, credit, source, licence, focal point or access of a media item; the file itself never changes.',
  requires: 'media:write',
  input: z.object({ id: MediaId, ...Editorial }).strict(),
  output: MediaView,
  examples: [
    {
      input: {
        id: exampleId(0xd001),
        caption: { nl: 'Demonstratie op het Malieveld', en: 'Demonstration at the Malieveld' },
        credit: { work: null, photographer: 'A. Fotograaf' },
      },
    },
  ],
  async handler(ctx, { id, ...patch }) {
    await requireMedia(ctx, id);
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    );
    await ctx.media.update(id, changes as MediaPatch, ctx.clock.now());
    return toMediaView(ctx, await requireMedia(ctx, id));
  },
});

export const deleteMedia = defineUseCase({
  name: 'media.delete',
  kind: 'command',
  description:
    'Move a media item that nothing uses any more to the trash; it answers 404 at once and can be restored for 30 days.',
  requires: 'media:write',
  consumes: null,
  input: z.object({ id: MediaId }).strict(),
  output: z.object({ id: MediaId, restorableUntil: IsoDate }),
  examples: [{ input: { id: exampleId(0xd001) } }],
  async handler(ctx, { id }) {
    // The lock every reference-checking save takes (content/service.ts `blockReferenceIssues`):
    // a save and this delete serialise, so the usage count below includes a save that won.
    await ctx.media.lock();
    const m = await requireMedia(ctx, id);
    // ADR 004 rule 6: a live reference refuses. The count only, never where (refs may be drafts).
    if (m.usageCount > 0)
      throw new UseCaseError('conflict', `this media is in use in ${m.usageCount} place(s)`, [
        { path: 'id', message: 'media.in-use' },
      ]);
    const now = ctx.clock.now();
    await ctx.media.softDelete(id, now);
    return { id, restorableUntil: restorableUntil(now).toISOString() };
  },
});

const MediaIds = z
  .array(MediaId)
  .min(1)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, 'media.duplicate');

export const bulkDeleteMedia = defineUseCase({
  name: 'media.bulk.delete',
  kind: 'command',
  description:
    'Move up to 100 media items to the trash, reporting per item: deleted, in use (with the number of places, never where) or not found. Asking again for an item already in the trash is deleted again, so a retry is safe.',
  requires: 'media:write',
  consumes: null,
  input: z.object({ ids: MediaIds }).strict(),
  output: z.object({
    results: z.array(
      z.object({
        id: MediaId,
        status: z.enum(['deleted', 'in-use', 'not-found']),
        usageCount: z.number().int().nonnegative().optional(),
        restorableUntil: IsoDate.optional(),
      })
    ),
  }),
  examples: [{ input: { ids: [exampleId(0xd001)] } }],
  async handler(ctx, { ids }) {
    await ctx.media.lock();
    const now = ctx.clock.now();
    const results = [];
    for (const id of ids) {
      const m = await ctx.media.get(id);
      if (!m) results.push({ id, status: 'not-found' as const });
      else if (m.deletedAt)
        results.push({
          id,
          status: 'deleted' as const,
          restorableUntil: restorableUntil(m.deletedAt).toISOString(),
        });
      else if (m.usageCount > 0)
        results.push({ id, status: 'in-use' as const, usageCount: m.usageCount });
      else {
        await ctx.media.softDelete(id, now);
        results.push({
          id,
          status: 'deleted' as const,
          restorableUntil: restorableUntil(now).toISOString(),
        });
      }
    }
    return { results };
  },
});

export const restoreMedia = defineUseCase({
  name: 'media.restore',
  kind: 'command',
  description:
    'Restore up to 100 media items from the trash, reporting per item: restored, expired, over the storage limit or not found. A restored item is live again; nothing that referred to it existed, because only unused items can be deleted.',
  requires: 'media:write',
  // Not `media.storage_max_bytes`: over the limit is a result per item, not a refusal of the call.
  consumes: null,
  input: z.object({ ids: MediaIds }).strict(),
  output: z.object({
    results: z.array(
      z.object({
        id: MediaId,
        status: z.enum(['restored', 'expired', 'over-limit', 'not-found']),
      })
    ),
  }),
  examples: [{ input: { ids: [exampleId(0xd001)] } }],
  async handler(ctx, { ids }) {
    // The cap is exact under the lock uploads take, and the purge job too.
    await ctx.media.lock();
    const now = ctx.clock.now();
    let used = await ctx.usage.storageBytes();
    const fits = (bytes: number) => {
      try {
        withinLimit(ctx, 'media.storage_max_bytes', used, bytes);
        return true;
      } catch (e) {
        if (e instanceof UseCaseError && e.code === 'limit_exceeded') return false;
        throw e;
      }
    };
    const results = [];
    for (const id of ids) {
      const m = await ctx.media.get(id);
      if (!m) results.push({ id, status: 'not-found' as const });
      else if (!m.deletedAt) results.push({ id, status: 'restored' as const });
      else if (restorableUntil(m.deletedAt) <= now)
        results.push({ id, status: 'expired' as const });
      else if (!fits(m.totalBytes)) results.push({ id, status: 'over-limit' as const });
      else {
        await ctx.media.restore(id, now);
        used += m.totalBytes;
        results.push({ id, status: 'restored' as const });
      }
    }
    return { results };
  },
});

export const listMediaTrash = defineUseCase({
  name: 'media.trash.list',
  kind: 'query',
  description:
    'List the media items in the trash of this site, most recently deleted first, with the moment each is removed for good.',
  // Deleted files are for those who can act on them, not for every reader of the library.
  requires: 'media:write',
  input: z
    .object({
      offset: z.number().int().min(0).max(MAX_LIST_OFFSET).optional(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    })
    .strict(),
  output: z.object({
    items: z.array(
      z.object({
        id: MediaId,
        filename: z.string(),
        kind: MediaKind,
        sizeBytes: z.number().int().nonnegative(),
        deletedAt: IsoDate,
        restorableUntil: IsoDate,
      })
    ),
    total: z.number().int().nonnegative(),
  }),
  examples: [{ input: {} }],
  async handler(ctx, { offset, limit = 50 }) {
    const since = new Date(ctx.clock.now().getTime() - MEDIA_TRASH_RETENTION_MS);
    const [rows, total] = [
      await ctx.media.listTrash({ since, offset, limit }),
      await ctx.media.countTrash(since),
    ];
    return {
      items: rows.map((m) => ({
        id: m.id,
        filename: m.filename,
        kind: m.kind,
        sizeBytes: m.sizeBytes,
        deletedAt: m.deletedAt!.toISOString(),
        restorableUntil: restorableUntil(m.deletedAt!).toISOString(),
      })),
      total,
    };
  },
});

/**
 * The `media.purge` job (tenant job), for jobs planned before the trash: delete the files, then the row. Idempotent: a missing key
 * is not an error and a row already gone is fine. Only keys of this tenant's asset are touched,
 * whatever the payload says.
 */
export async function purgeMedia(
  ctx: TransactionContext,
  { mediaId, keys }: { mediaId: string; keys: string[] }
): Promise<void> {
  const own = mediaKey(ctx.principal.tenantId, mediaId, '');
  const foreign = keys.filter((k) => !k.startsWith(own) || k.includes('..'));
  if (foreign.length) throw new Error(`media.purge: keys outside ${own}: ${foreign.join(', ')}`);
  // Serialises with `media.restore`, and a restored asset keeps its files: a job planned before
  // the trash existed must not take them.
  await ctx.media.lock();
  const m = await ctx.media.get(mediaId);
  if (m && !m.deletedAt) return;
  await ctx.blobs.delete(keys);
  await ctx.media.hardDelete(mediaId);
}

const TRASH_BATCH = 500;

/**
 * What ended the retention of the trash: files first, then the row, under the media lock so a
 * restore serialises with it. The daily sweep calls it, which also covers a row an import brought
 * in without any job. A batch at a time; the next day takes the rest.
 */
async function purgeExpiredTrash(ctx: TransactionContext): Promise<string[]> {
  await ctx.media.lock();
  const before = new Date(ctx.clock.now().getTime() - MEDIA_TRASH_RETENTION_MS);
  const purged: string[] = [];
  for (const m of await ctx.media.expiredTrash(before, TRASH_BATCH)) {
    const keys = mediaKeys(ctx.principal.tenantId, m);
    await ctx.blobs.delete(keys);
    await ctx.media.hardDelete(m.id);
    purged.push(...keys);
  }
  return purged;
}

/**
 * The orphan sweep for one tenant (`media.orphans`, run per tenant in its own transaction, ADR
 * 011 rule 1): every key under the tenant's media prefix whose media id has no row and which is
 * older than `ORPHAN_AGE_MS` is deleted. Younger files may belong to an upload that has not
 * committed yet. Returns the deleted keys.
 */
export async function sweepMediaOrphans(ctx: TransactionContext): Promise<string[]> {
  const expired = await purgeExpiredTrash(ctx);
  const known = new Set(await ctx.media.idsOf());
  const prefix = mediaPrefix(ctx.principal.tenantId);
  const cutoff = ctx.clock.now().getTime() - ORPHAN_AGE_MS;
  const stale: string[] = [];
  for await (const { key, modifiedAt } of ctx.blobs.list(prefix)) {
    const id = key.slice(prefix.length).split('/')[0] ?? '';
    if (!known.has(id) && modifiedAt.getTime() < cutoff) stale.push(key);
  }
  if (stale.length) await ctx.blobs.delete(stale);
  return [...expired, ...stale];
}
