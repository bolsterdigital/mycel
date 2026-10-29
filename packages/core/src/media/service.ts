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
import { UseCaseError } from '../errors.js';
import { jobKey } from '../jobs/types.js';
import '../jobs/ports.js';
import '../entitlements/ports.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { base64ToBytes } from '../util/bytes.js';
import { sha256HexOfBytes } from '../util/digest.js';
import { errorFields } from '../util/log.js';
import {
  CENTRE,
  CONTENT_TYPE_OF,
  MAX_PIXELS,
  MAX_UPLOAD_BYTES,
  MEDIA_PURGE_DELAY_MS,
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
  variantFile,
  variantWidths,
  type MediaPatch,
  type MediaRecord,
  type StoredVariant,
} from './model.js';
import './ports.js';

const MediaId = z.string().guid();

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
      .max(200, 'media.filename.too_long')
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
  if (!m || m.deletedAt) throw new UseCaseError('not_found', 'no media with that id');
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

/** Check what the bytes are, then render everything that will be stored. */
async function prepare(
  ctx: TransactionContext,
  contentType: MediaContentType,
  bytes: Uint8Array
): Promise<Prepared> {
  if (contentType === 'application/pdf') {
    if (!startsWith(bytes, '%PDF-'))
      throw invalid('contentType', 'media.type.mismatch', 'the file is not a PDF');
    const variant: StoredVariant = {
      name: 'file',
      format: 'pdf',
      width: null,
      height: null,
      bytes: bytes.length,
    };
    return {
      kind: 'document',
      width: null,
      height: null,
      primary: bytes,
      variants: [variant],
      files: [{ file: variantFile(variant), bytes, contentType }],
    };
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
      'media.pixels.too_many',
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
    'Upload an image (JPEG, PNG, WebP, AVIF, GIF) or a PDF as base64, up to 25 MB; images are stored without metadata, with AVIF and WebP variants.',
  requires: 'media:write',
  consumes: 'media.storage_max_bytes',
  input: z
    .object({
      filename: Filename,
      contentType: z.string().min(1).max(100),
      bytes: z
        .string()
        .min(1, 'media.bytes.empty')
        .max(MAX_BASE64, 'media.size.too_large')
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
      throw invalid('bytes', 'media.size.too_large', 'the file is larger than 25 MB');

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
  examples: [{ input: { id: '01900000-0000-7000-8000-00000000d001' } }],
  async handler(ctx, { id }) {
    return toMediaView(ctx, await requireMedia(ctx, id));
  },
});

export const listMedia = defineUseCase({
  name: 'media.list',
  kind: 'query',
  description:
    'List the media of this site, newest first, a page at a time; `q` finds a filename or caption that contains it.',
  requires: 'media:read',
  input: z
    .object({
      kind: MediaKind.optional(),
      q: z.string().trim().min(1).max(100).optional(),
      cursor: MediaId.optional(),
      /** Default 50. */
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  output: z.object({ items: z.array(MediaView), nextCursor: MediaId.nullable() }),
  examples: [{ input: {} }],
  async handler(ctx, { kind, q, cursor, limit = 50 }) {
    const rows = await ctx.media.list({ kind, q, cursor, limit: limit + 1 });
    const page = rows.slice(0, limit);
    return {
      items: page.map((m) => toMediaView(ctx, m)),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
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
        id: '01900000-0000-7000-8000-00000000d001',
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
    'Delete a media item that nothing uses any more; a job removes its files 24 hours later, so a running backup still finds them.',
  requires: 'media:write',
  consumes: null,
  input: z.object({ id: MediaId }).strict(),
  output: z.object({ id: MediaId, purgeScheduled: z.boolean() }),
  examples: [{ input: { id: '01900000-0000-7000-8000-00000000d001' } }],
  async handler(ctx, { id }) {
    // The lock every reference-checking save takes (content/service.ts `blockReferenceIssues`):
    // a save and this delete serialise, so the usage count below includes a save that won.
    await ctx.media.lock();
    const m = await requireMedia(ctx, id);
    // ADR 004 rule 6: a live reference refuses. The count only, never where (refs may be drafts).
    if (m.usageCount > 0)
      throw new UseCaseError('conflict', `this media is in use in ${m.usageCount} place(s)`, [
        { path: 'id', message: 'media.in_use' },
      ]);
    const now = ctx.clock.now();
    await ctx.media.softDelete(id, now);
    // In this transaction: the files go if and only if the delete commits, and not before a
    // backup or export that already holds the row has copied them (MEDIA_PURGE_DELAY_MS).
    const purgeScheduled = await ctx.jobs.enqueue({
      type: 'media.purge',
      key: jobKey('media.purge', id),
      runAt: new Date(now.getTime() + MEDIA_PURGE_DELAY_MS),
      payload: { mediaId: id, keys: mediaKeys(ctx.principal.tenantId, m) },
    });
    return { id, purgeScheduled };
  },
});

/**
 * The `media.purge` job (tenant job): delete the files, then the row. Idempotent: a missing key
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
  await ctx.blobs.delete(keys);
  await ctx.media.hardDelete(mediaId);
}

/**
 * The orphan sweep for one tenant (`media.orphans`, run per tenant in its own transaction, ADR
 * 011 rule 1): every key under the tenant's media prefix whose media id has no row and which is
 * older than `ORPHAN_AGE_MS` is deleted. Younger files may belong to an upload that has not
 * committed yet. Returns the deleted keys.
 */
export async function sweepMediaOrphans(ctx: TransactionContext): Promise<string[]> {
  const known = new Set(await ctx.media.idsOf());
  const prefix = mediaPrefix(ctx.principal.tenantId);
  const cutoff = ctx.clock.now().getTime() - ORPHAN_AGE_MS;
  const stale: string[] = [];
  for await (const { key, modifiedAt } of ctx.blobs.list(prefix)) {
    const id = key.slice(prefix.length).split('/')[0] ?? '';
    if (!known.has(id) && modifiedAt.getTime() < cutoff) stale.push(key);
  }
  if (stale.length) await ctx.blobs.delete(stale);
  return stale;
}
