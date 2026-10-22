// The delivery of media variants on the site itself (TODO #10, brief decision 8): what
// `/media/<id>/<file>` answers, as a function over the ports so it is testable without a server.
// The route file only passes the runtime's pieces in.
//
//   unknown id, unknown file, `original.*`, deleted or not ready  -> 404
//   restricted without a valid signature (ADR 018 rule 7)        -> 403, private, no-store
//   restricted with one                                          -> 200, private, no-store
//   public                                                       -> 200, public, immutable
//
// A variant's key contains the media id and never changes (replacing a file is a new id), so a
// public variant is cacheable for a year. The row is read as an anonymous visitor of the site
// with `media:read` only, so RLS picks the tenant from the hostname, never from the URL.
// Rejected: serving bytes from the API package (the API is for integrations, the site is here)
// and redirecting to a bucket URL (the bucket is private, ADR 018 rules 7 and 8).

import {
  CONTENT_TYPE_OF,
  anonymousPrincipal,
  mediaKey,
  variantFile,
  verifyMediaSignature,
  type BlobStore,
  type Clock,
  type Signer,
  type TenantRef,
  type UnitOfWork,
} from '@mycel/core';

export interface MediaDeliveryDeps {
  uow: UnitOfWork;
  blobs: BlobStore;
  signer: Signer;
  clock: Clock;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** What a variant file may be called; `original.*` never matches. */
const FILE = /^(w\d{1,5}|thumb|file)\.(avif|webp|gif|pdf)$/;

const status = (code: number, cache = 'no-store') =>
  new Response(null, {
    status: code,
    headers: { 'cache-control': cache, 'x-content-type-options': 'nosniff' },
  });

/** `inline; filename="x"` plus an RFC 5987 form for names that are not plain ASCII. */
function disposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return ascii === filename
    ? `inline; filename="${filename}"`
    : `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function serveMedia(
  deps: MediaDeliveryDeps,
  /** The visited site's tenant with its access (`siteTenant(site)`). */
  tenant: Exclude<TenantRef, string>,
  id: string,
  file: string,
  url: URL,
  ifNoneMatch: string | null = null
): Promise<Response> {
  if (!UUID.test(id) || !FILE.test(file)) return status(404);
  const visitor = anonymousPrincipal(tenant, ['media:read']);
  const media = await deps.uow.run(visitor, (ctx) => ctx.media.get(id));
  const variant = media?.variants.find((v) => variantFile(v) === file);
  if (!media || media.deletedAt || media.state !== 'ready' || !variant) return status(404);

  const restricted = media.access === 'restricted';
  if (
    restricted &&
    !(await verifyMediaSignature(
      deps.signer,
      id,
      file,
      url.searchParams.get('exp'),
      url.searchParams.get('sig'),
      deps.clock.now()
    ))
  )
    return status(403, 'private, no-store');

  const etag = `"${media.checksum}:${variant.name}.${variant.format}"`;
  const headers: Record<string, string> = {
    'content-type': CONTENT_TYPE_OF[variant.format],
    etag,
    'cache-control': restricted ? 'private, no-store' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    ...(media.kind === 'document' ? { 'content-disposition': disposition(media.filename) } : {}),
  };
  if (!restricted && ifNoneMatch?.split(',').some((t) => t.trim() === etag))
    return new Response(null, { status: 304, headers });

  const bytes = await deps.blobs.get(mediaKey(tenant.id, id, file));
  if (!bytes) {
    console.error(`media ${id}: ${file} is in the register but not in the store`);
    return status(404);
  }
  // A copy into a plain ArrayBuffer: what `BodyInit` takes, whatever buffer the store returned.
  return new Response(new Uint8Array(bytes).buffer, {
    headers: { ...headers, 'content-length': String(bytes.length) },
  });
}
