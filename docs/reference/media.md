# Media

The media library of a site (PRs #15 and #16): one register of uploaded files per tenant, the files behind a storage port, and variants served by the site itself. This page is the contract for the `image` block (PR #25), og-images, reader access and a later delivery adapter (a CDN or an image service). The reasoning is in ADR 004 (rules 4 and 6), 008, 011, 015, 018 (rules 7 and 8) and 019 (rules 6 and 8).

## The model in one paragraph

Content refers to a **media id**, never to a URL. Mycel owns the record (id, checksum, sizes, editorial fields, usages, state) in the `media` table; the bytes live in a `BlobStore` under keys derived from the id. Three ports keep three concerns apart: `BlobStore` (storage), `ImageProcessor` (processing) and `MediaDelivery` (where a variant is served). Swapping a directory for a bucket, sharp for another library, or the site's own route for a CDN changes no content.

## Use cases

| Use case       | Kind    | Capability    | Notes                                                                                                                                                      |
| -------------- | ------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media.upload` | command | `media:write` | base64 JSON, at most 25 MB decoded; consumes `media.storage_max_bytes` (original plus every variant)                                                       |
| `media.get`    | query   | `media:read`  | also the MCP resource `mycel://media/{id}`                                                                                                                 |
| `media.list`   | query   | `media:read`  | newest first, `{ kind?, q?, cursor?, limit ≤ 100 }` (`q`: filename or caption contains, case-insensitive), `nextCursor`; also `GET /v1/media.list?limit=…` |
| `media.update` | command | `media:write` | caption, credit, source, licence, focal point, access; the file never changes (upload again for a new file, a new id)                                      |
| `media.delete` | command | `media:write` | `conflict` while usages exist (the count only, never where); otherwise soft-deletes and plans `media.purge` for 24 hours later in the same transaction     |

Accepted: `image/jpeg`, `image/png`, `image/webp`, `image/avif`, `image/gif`, `application/pdf`. **SVG is refused** (`media.type.svg`): scripts in an SVG run on the site; a logo or wordmark comes through the theme (ADR 013), not through the library. The content type is checked against the bytes (`media.type.mismatch`, `media.type.unreadable`), and an image larger than **50 megapixels** is refused from its header before anything is decoded (`media.pixels.too-many`); for an animated GIF every frame counts, because the whole animation is decoded at once (500x500 pixels at 200 frames is the limit). Over HTTP a body larger than the base64 of 25 MB plus 1 MB is `413 urn:mycel:problem:payload_too_large`.

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

**Signed paths** (ADR 018 rule 7): `signedVariantPath(signer, id, file, expiresAt)` adds `exp` (unix seconds) and `sig`, a token of the core `Signer` over `media:<id>:<file>:<exp>`; `verifyMediaSignature` checks it. A signature opens one file of one asset until it expires; the media id is globally unique and is read under the visited site's tenant, so it opens nothing elsewhere. Who gets a signed path (a reader with access) is #19; the admin's "download original" is an admin route, because the public route never serves an original (see below).

## The admin

`/admin/<tenant>/media` (PR #16) uploads, lists, edits and deletes through the same use cases, with native form posts and no JavaScript. The upload is a multipart form; the action turns the file into base64 and calls `media.upload`, so there is one contract for the admin, HTTP and MCP. The web process accepts bodies up to 26M for that form only (`BODY_SIZE_LIMIT`, set in `docker/entrypoint.sh`); `hooks.server.ts` counts actual bytes and answers `413` above 512K for every other request, including chunked bodies and the media update/delete actions. The 26M exception applies only to multipart POSTs selecting the upload action. Storage statistics are shown only to tenant administrators; media editors need only their media capabilities to use the library.

The upload form takes several files at once and reports per file; `?q=` searches the library. Wherever an editor chooses an image (an image block, the hero image, the article writer's image card), the shared `MediaPicker` shows a grid of thumbnails as radio buttons in a native `<dialog>`, which works without JavaScript. `static/_admin/media-picker.js` adds search through `GET /admin/<tenant>/media/choices?q=&cursor=` and uploading with progress through `POST /admin/<tenant>/media/upload` (multipart, one file, JSON back); both run the same use cases as the operator. That upload route has the same 26M ceiling as the upload action.

The admin runs on the platform origin, so it serves its own files instead of the site's `/media/...` route:

| Route                                           | Requires                                                    | Answer                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `/admin/<tenant>/media/<id>/thumb`              | an operator of the tenant with `media:read`                 | `thumb.webp`, `private, max-age=300`                                                   |
| `/admin/<tenant>/media/<id>/original?exp=&sig=` | the same, plus a signature made by the page for ten minutes | `original.<ext>` (or `file.<ext>` for a PDF or GIF), `attachment`, `private, no-store` |

Without a session or membership both are `403`; another site's id is `404` (RLS reads the row under the operator's principal). The signature uses the same `signedVariantPath` over the file name, so a copied download link stops working after ten minutes.

## Usages and deleting

`media_usages` (`tenant_id`, `media_id`, `ref`, `block_id`) records references. `ref` is opaque to the media module: `item:<id>:rev:<id>` for a revision's block tree and its hero, featured and share image (block ids `doc:hero`, `doc:featured`, `doc:seo`), `pattern:<id>` for a pattern, `site:images` for the site's default image (block id `default-image`), `og:<...>` for a cached og-image. The writer replaces all rows of one ref in its own transaction:

```ts
await ctx.media.replaceUsages(`item:${itemId}:rev:${revisionId}`, [
  { mediaId, blockId }, // one per image block and per hero image
]);
```

The repository skips an unknown or deleted media id and returns how many rows it wrote; the content module checks the reference first and refuses a save whose count falls short, so a usage is never silently missing (`docs/reference/content-model.md` § Media references). Usages of older revisions stay: deleting is refused while any revision or pattern uses the asset. `media.get` shows `usageCount`; `media.delete` takes the tenant's media lock, then refuses with `conflict` (issue `media.in-use`) while it is above zero (ADR 004 rule 6). Content saves take the same lock before they read media, so a save and a delete of one asset never both succeed.

A delete sets `deleted_at` (the asset disappears from every read and from the storage count at once) and plans `media.purge { mediaId, keys }` in the same transaction, to run 24 hours later (`MEDIA_PURGE_DELAY_MS` in `model.ts`, PR #38): a deleted file stays in storage that long, never served. The delay is the window in which a backup or export that started before the delete still finds the files of a row its database snapshot holds; both fail rather than run longer than half of it ([`../self-hosting.md`](../self-hosting.md#backups), [`export.md`](export.md#what-travels-in-this-order)). The purge (a tenant job) deletes the keys and then the row; it is idempotent, refuses keys outside its own asset's prefix, and runs for a suspended tenant too (deleting is not publishing). The daily platform job `media.orphans` takes the tenant list from the platform role and sweeps each tenant in its own unit of work as `mycel_app`: every key under the tenant's prefix whose media id has no row and which is older than 24 hours is deleted. Younger files may belong to an upload whose transaction has not committed. There is no cross-tenant policy on `media` (ADR 011 rule 1).

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

## For the `image` block

Props (#8b2): `{ mediaId, decorative, alt: localised | null, caption?: localised, credit?: MediaCredit, layout }`; alt is required unless decorative, and null when decorative. A block caption or credit overrides the asset's for this use; an absent one inherits it; an empty caption string hides it in that locale. A hero's image has the same props with `layout: content`. A save refuses a media id that is unknown in the tenant, deleted or not an image.

The renderer (#8c) reads the asset with `media.get` (or the repository in the same transaction), builds `srcset` from the `variants` of one format each (`<picture>` with an AVIF and a WebP `<source>`), sets `width` and `height` from the asset (ADR 009 rule 4), and `object-position` from `focal`. A missing caption translation is not filled from another locale. A restricted asset has empty paths; such an image renders only for a reader with access, with signed paths (#19); an anonymous visitor never gets a restricted path.

## A later delivery adapter

A CDN or an image service (ImageKit) is another `MediaDelivery`: `variantPath` returns its URL for the same `(id, file)`, `signedVariantPath` its signed form. The variants and their names stay what this page lists, so content and the register do not change; the composition root (`packages/api/src/runtime/compose.ts`, `media.delivery`) is the only place that changes. Moving files between stores is a copy of the `tenants/` prefix; the keys are the contract.

## Constants

| Constant               | Value                        | Where                                | Why                                                                 |
| ---------------------- | ---------------------------- | ------------------------------------ | ------------------------------------------------------------------- |
| `MAX_UPLOAD_BYTES`     | 25 MiB                       | `packages/core/src/media/model.ts`   | decoded upload size; the base64 body is a third larger              |
| `MAX_PIXELS`           | 50,000,000                   | `packages/core/src/media/model.ts`   | refuses decompression bombs                                         |
| `VARIANT_WIDTHS`       | 320, 640, 960, 1280, 1920 px | `packages/core/src/media/model.ts`   | fixed variant widths, never upscaled                                |
| `VARIANT_FORMATS`      | `avif`, `webp`               | `packages/core/src/media/model.ts`   | one `<source>` per format in `<picture>`                            |
| `THUMB_WIDTH`          | 160 px                       | `packages/core/src/media/model.ts`   | the `thumb.webp` the admin and picker show                          |
| `MEDIA_PURGE_DELAY_MS` | 24 h                         | `packages/core/src/media/model.ts`   | a backup or export that began before a delete still finds the files |
| `ORPHAN_AGE_MS`        | 24 h                         | `packages/core/src/media/service.ts` | younger orphans may belong to an upload that has not committed      |
| `ORIGINAL_TTL_MS`      | 10 min                       | `apps/web/src/lib/server/media.ts`   | how long a signed download link for an original works               |
| `media.list` `limit`   | default 50, at most 100      | `packages/core/src/media/service.ts` | bounds one page of the library                                      |
| `PART_BYTES`           | 16 MiB                       | `packages/blob/src/s3.ts`            | one part in memory at a time, and 10,000 parts reach 160 GiB        |
| `BATCH`                | 1,000 keys                   | `packages/blob/src/s3.ts`            | DeleteObjects takes at most a thousand keys per call                |
