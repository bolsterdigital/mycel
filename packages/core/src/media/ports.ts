// Three ports, three responsibilities (fundamentcheck 2026-10-21: storage, processing and
// delivery apart), plus the repository. Storage can move from a directory to a bucket, sharp can
// be replaced, and a CDN can take over delivery, without any content changing: content carries
// media ids only (ADR 004 rule 4).
//
// Rejected: URLs in the `image` block (vendor lock-in inside content) and a public bucket with
// direct links (originals and restricted media would then have an address).

import type { Signer } from '../ports.js';
import type { ImageFormat, MediaKind, MediaPatch, MediaRecord, NewMedia } from './model.js';

/**
 * Bytes under keys. Keys are paths (`tenants/<id>/media/<id>/w960.avif`); `put` is idempotent on
 * the key (the same key gets the same bytes). No URLs come out of this port: a bucket is never
 * public, delivery is `MediaDelivery`'s business.
 */
export interface BlobStore {
  put(key: string, bytes: Uint8Array, options: { contentType: string }): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  head(key: string): Promise<{ size: number; contentType: string } | null>;
  /** A missing key is not an error. */
  delete(keys: readonly string[]): Promise<void>;
  /** Every key under `prefix`, with when it was last written (the orphan sweep's age test). */
  list(prefix: string): AsyncIterable<{ key: string; size: number; modifiedAt: Date }>;
}

export interface ImageProbe {
  format: ImageFormat;
  /** After EXIF orientation is applied: what a viewer sees. */
  width: number;
  height: number;
  /**
   * Frames of an animation, 1 for a still. A decoder loads every frame of an animation at once,
   * so the pixel limit counts `width * height * pages`, not one frame.
   */
  pages: number;
}

export interface RenderOptions {
  width: number;
  format: ImageFormat;
  /** Always true: there is no option to keep metadata, the field documents the promise. */
  stripMetadata: true;
}

/**
 * Image processing. `probe` reads the header only (magic bytes and dimensions), so a decompression
 * bomb is caught before anything is decoded; `render` applies the EXIF orientation and writes no
 * metadata at all. A GIF is rendered with all its frames.
 */
export interface ImageProcessor {
  probe(bytes: Uint8Array): Promise<ImageProbe | null>;
  render(
    bytes: Uint8Array,
    options: RenderOptions
  ): Promise<{ bytes: Uint8Array; width: number; height: number }>;
}

/**
 * Where a variant is delivered. The default (`appDelivery`) is a path on the site itself; a CDN
 * or image service is another implementation of this port and changes no content.
 */
export interface MediaDelivery {
  /** `file` is the variant file name (`w960.avif`). */
  variantPath(mediaId: string, file: string): string;
  /** The same path with `?exp=&sig=`, for a restricted asset (ADR 018 rule 7). */
  signedVariantPath(
    signer: Signer,
    mediaId: string,
    file: string,
    expiresAt: Date
  ): Promise<string>;
}

export interface MediaListQuery {
  kind?: MediaKind | undefined;
  /** The id of the last item of the previous page. */
  cursor?: string | undefined;
  limit: number;
}

export interface MediaUsage {
  mediaId: string;
  blockId: string;
}

export interface MediaRepository {
  /** Serialise uploads of this tenant until the transaction ends (the storage cap). */
  lock(): Promise<void>;
  /** Soft-deleted rows too, with `deletedAt` set; the service decides what that means. */
  get(id: string): Promise<MediaRecord | null>;
  /** Newest first, without soft-deleted rows. */
  list(query: MediaListQuery): Promise<MediaRecord[]>;
  insert(media: NewMedia): Promise<void>;
  update(id: string, patch: MediaPatch, at: Date): Promise<boolean>;
  softDelete(id: string, at: Date): Promise<boolean>;
  /** Removes the row and its usages, only once it was soft-deleted. */
  hardDelete(id: string): Promise<boolean>;
  /**
   * Replace every usage recorded under `ref` (`item:<id>:rev:<id>`, `og:<...>`) with `usages`, in
   * the caller's transaction. #8b1 calls this when it saves a block tree; a soft-deleted or
   * unknown media id is skipped. Returns how many usages it recorded.
   */
  replaceUsages(ref: string, usages: readonly MediaUsage[]): Promise<number>;
  /** Every media id of this tenant, soft-deleted ones included (the orphan sweep). */
  idsOf(): Promise<string[]>;
}

declare module '../ports.js' {
  interface TransactionContext {
    media: MediaRepository;
    blobs: BlobStore;
    images: ImageProcessor;
    delivery: MediaDelivery;
  }
}
