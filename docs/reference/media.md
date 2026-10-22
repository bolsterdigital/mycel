# Media

The media library of a site (TODO #10): one register of uploaded files per tenant, the files behind a storage port, and variants served by the site itself. This page is the contract for the `image` block (#8b2), og-images (#9), reader access (#19) and a later delivery adapter (a CDN or an image service). The reasoning is in ADR 004 (rules 4 and 6), 008, 011, 015, 018 (rules 7 and 8) and 019 (rules 6 and 8).

## The model in one paragraph

Content refers to a **media id**, never to a URL. Mycel owns the record (id, checksum, sizes, editorial fields, usages, state) in the `media` table; the bytes live in a `BlobStore` under keys derived from the id. Three ports keep three concerns apart: `BlobStore` (storage), `ImageProcessor` (processing) and `MediaDelivery` (where a variant is served). Swapping a directory for a bucket, sharp for another library, or the site's own route for a CDN changes no content.

## Use cases

| Use case       | Kind    | Capability    | Notes                                                                                                                               |
| -------------- | ------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `media.upload` | command | `media:write` | base64 JSON, at most 25 MB decoded; consumes `media.storage_max_bytes` (original plus every variant)                                |
| `media.get`    | query   | `media:read`  | also the MCP resource `mycel://media/{id}`                                                                                          |
| `media.list`   | query   | `media:read`  | newest first, `{ kind?, cursor?, limit ≤ 100 }`, `nextCursor`; also `GET /v1/media.list?limit=…`                                    |
| `media.update` | command | `media:write` | caption, credit, source, licence, focal point, access; the file never changes (upload again for a new file, a new id)               |
| `media.delete` | command | `media:write` | `conflict` while usages exist (the count only, never where); otherwise soft-deletes and plans `media.purge` in the same transaction |

Accepted: `image/jpeg`, `image/png`, `image/webp`, `image/avif`, `image/gif`, `application/pdf`. **SVG is refused** (`media.type.svg`): scripts in an SVG run on the site; a logo or wordmark comes through the theme (ADR 013), not through the library. The content type is checked against the bytes (`media.type.mismatch`, `media.type.unreadable`), and an image larger than **50 megapixels** is refused from its header before anything is decoded (`media.pixels.too_many`); for an animated GIF every frame counts, because the whole animation is decoded at once (500x500 pixels at 200 frames is the limit). Over HTTP a body larger than the base64 of 25 MB plus 1 MB is `413 urn:mycel:problem:payload_too_large`.

The upload is synchronous: probe, render every variant, then take the tenant's media lock, count the storage, write the files and the row. Rendering happens before the lock, so the lock covers only the count and the writes. If a write fails, the files already written are removed (best effort); whatever a crash leaves is swept by `media.orphans`.

## What is stored

Keys: `tenants/<tenant id>/media/<media id>/<file>`.

| Kind                  | Files                                                                                                                                                                                                                                                                                              |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JPEG, PNG, WebP, AVIF | `original.<ext>` (private: the upload re-encoded at its own size, orientation applied, **no metadata**), `w<width>.avif` and `w<width>.webp` for 320, 640, 960, 1280 and 1920 up to the image's width, plus its own width when that is below 1920 and not one of them, and `thumb.webp` (160 wide) |
| GIF                   | `file.gif` (all frames, no metadata; delivered as stored) and `thumb.webp` (first frame)                                                                                                                                                                                                           |
| PDF                   | `file.pdf` (delivered as stored)                                                                                                                                                                                                                                                                   |

Never upscaled. A 4000 px photo stops at `w1920`: its full resolution stays private. `checksum` (sha256 hex) and `sizeBytes` describe the stored original (or `file`), `totalBytes` everything, which is what the cap counts. A PDF's own metadata (author, producer) is not rewritten: only images pass through the processor.

The unmodified upload is never kept. A photo with the GPS position of a source must not survive even in a leaked backup; whoever needs the pristine file keeps it outside Mycel.

## Editorial fields

`caption` (localised, may be empty), `credit` (`{ work: { title, maker } | null, photographer: string | null }`: the work and its maker, and the photographer, are two credits), `source`, `licence` (free short text, at most 100 characters), `focal` (`{ x, y }` in 0..1, default the centre), `access` (`public` or `restricted`). **Alt text and "decorative" are not on the asset**: they belong to the use of an image, in the block.

## Delivery

`MediaDelivery.variantPath(id, file)` gives `/media/<id>/<file>`, a path on the site itself (`appDelivery`). The route `apps/web/src/routes/(public)/[tenant]/media/[id]/[variant]/+server.ts` serves it on every hostname of the tenant and, in development, under the path form `/<slug>/media/<id>/<file>` (a renderer builds the link with `sitePath(site, variant.path)`).

| Request                                                                          | Answer                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public variant                                                                   | `200`, `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<checksum>:<file>"`, `X-Content-Type-Options: nosniff`; `304` on a matching `If-None-Match` |
| PDF                                                                              | as above, plus `Content-Disposition: inline; filename="<name>"` (and `filename*` for non-ASCII names)                                                            |
| restricted variant without a valid signature                                     | `403`, `Cache-Control: private, no-store`                                                                                                                        |
| restricted variant with `?exp=&sig=` from `signedVariantPath`                    | `200`, `Cache-Control: private, no-store`                                                                                                                        |
| `original.*`, an unknown file, an unknown id, another site's id, a deleted asset | `404` (also with a signature)                                                                                                                                    |

A variant never changes (a new file is a new id), which is why a public variant may be cached for a year. The same header means that making a public asset `restricted` later does not recall the copies browsers and shared caches already hold: an asset that must never have been public is uploaded as `restricted` from the start. The row is read as an anonymous visitor of the site with `media:read`, so RLS picks the tenant from the hostname, never from the URL.

**Signed paths** (ADR 018 rule 7): `signedVariantPath(signer, id, file, expiresAt)` adds `exp` (unix seconds) and `sig`, a token of the core `Signer` over `media:<id>:<file>:<exp>`; `verifyMediaSignature` checks it. A signature opens one file of one asset until it expires; the media id is globally unique and is read under the visited site's tenant, so it opens nothing elsewhere. Who gets a signed path (a reader with access) is #19; the admin's "download original" (#10b) is an admin route, because the public route never serves an original.

## Usages and deleting

`media_usages` (`tenant_id`, `media_id`, `ref`, `block_id`) records live references. `ref` is opaque to the media module: `item:<id>:rev:<id>` for a revision's block tree, `og:<...>` for a cached og-image. The writer replaces all rows of one ref in its own transaction:

```ts
await ctx.media.replaceUsages(`item:${itemId}:rev:${revisionId}`, [
  { mediaId, blockId }, // one per image block
]);
```

An unknown or deleted media id is skipped, never an error. `media.get` shows `usageCount`; `media.delete` refuses with `conflict` (issue `media.in_use`) while it is above zero (ADR 004 rule 6).

A delete sets `deleted_at` (the asset disappears from every read and from the storage count at once) and plans `media.purge { mediaId, keys }` in the same transaction. The purge (a tenant job) deletes the keys and then the row; it is idempotent, refuses keys outside its own asset's prefix, and runs for a suspended tenant too (deleting is not publishing). The daily platform job `media.orphans` takes the tenant list from the platform role and sweeps each tenant in its own unit of work as `mycel_app`: every key under the tenant's prefix whose media id has no row and which is older than 24 hours is deleted. Younger files may belong to an upload whose transaction has not committed. There is no cross-tenant policy on `media` (ADR 011 rule 1).

## Configuration

| Variable                                             | Default         | Meaning                                                                     |
| ---------------------------------------------------- | --------------- | --------------------------------------------------------------------------- |
| `BLOB_STORE`                                         | `fs`            | `fs` or `s3`; production requires `s3`                                      |
| `BLOB_DIR`                                           | `.scratch/blob` | the `fs` directory; relative to the repository root                         |
| `BLOB_S3_ENDPOINT`                                   | (AWS)           | e.g. `https://s3.fr-par.scw.cloud`, `https://fsn1.your-objectstorage.com`   |
| `BLOB_S3_REGION`                                     | `us-east-1`     |                                                                             |
| `BLOB_S3_BUCKET`                                     | (none)          | required for `s3`; the bucket stays private, nothing is ever served from it |
| `BLOB_S3_ACCESS_KEY_ID`, `BLOB_S3_SECRET_ACCESS_KEY` | (none)          | required for `s3`                                                           |
| `BLOB_S3_FORCE_PATH_STYLE`                           | `0`             | `1` for endpoints without virtual-hosted buckets (RustFS, MinIO)            |

Locally, `docker compose -f compose.dev.yml --profile blob up -d` starts an S3-compatible store (RustFS; MinIO no longer publishes images) and the `BLOB_S3_*` values in `.env.example` point at it; the contract suite in `packages/blob` then runs against it as well as against a directory. CI runs it against the same image.

The Docker image needs nothing extra: sharp's libvips binary for linux-x64 or arm64 (glibc) is an optional npm dependency and installs with `npm ci --ignore-scripts`.

## For the `image` block (#8b2)

Props: `{ mediaId, alt: localised | null, decorative: boolean, caption?: localised, layout }` (alt or decorative, never neither; the caption on the block overrides the asset's). The renderer reads the asset with `media.get` (or the repository in the same transaction), builds `srcset` from the `variants` of one format each (`<picture>` with an AVIF and a WebP `<source>`), sets `width` and `height` from the asset (ADR 009 rule 4), and `object-position` from `focal`. A restricted asset has empty paths; such an image renders only for a reader with access, with signed paths (#19). Saving a block tree calls `replaceUsages` for the revision.

## A later delivery adapter

A CDN or an image service (ImageKit) is another `MediaDelivery`: `variantPath` returns its URL for the same `(id, file)`, `signedVariantPath` its signed form. The variants and their names stay what this page lists, so content and the register do not change; the composition root (`packages/api/src/compose.ts`, `media.delivery`) is the only place that changes. Moving files between stores is a copy of the `tenants/` prefix; the keys are the contract.
