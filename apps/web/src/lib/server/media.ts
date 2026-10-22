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
  EXTENSION_OF,
  FORMAT_OF,
  anonymousPrincipal,
  appDelivery,
  can,
  mediaKey,
  variantFile,
  verifyMediaSignature,
  type BlobStore,
  type Clock,
  type FileFormat,
  type MediaContentType,
  type Logger,
  type Principal,
  type Signer,
  type TenantRef,
  type UnitOfWork,
} from '@mycel/core';

export interface MediaDeliveryDeps {
  uow: UnitOfWork;
  blobs: BlobStore;
  signer: Signer;
  clock: Clock;
  /** The runtime's logger; tests leave it out. */
  log?: Logger;
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
function disposition(filename: string, type: 'inline' | 'attachment' = 'inline'): string {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return ascii === filename
    ? `${type}; filename="${filename}"`
    : `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
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
    deps.log?.error('media: in the register but not in the store', { mediaId: id, file });
    return status(404);
  }
  // A copy into a plain ArrayBuffer: what `BodyInit` takes, whatever buffer the store returned.
  return new Response(new Uint8Array(bytes).buffer, {
    headers: { ...headers, 'content-length': String(bytes.length) },
  });
}

// The admin's own files (TODO #10b): the original for download and the thumbnail for the list.
// The admin runs on the platform origin, never on a tenant hostname (ADR 014 rule 4), so it
// cannot use the site's `/media/...` route; and that route never serves an original. Both answer
// only to an operator of the tenant (RLS reads the row under the operator's principal, so another
// site's id is a 404), privately. The original also needs a signed path that `+page.server.ts`
// made for ten minutes: a download link copied out of the admin stops working, and a forged
// request from another page (the cookie is SameSite=Lax) still lacks the signature.
//
//   no operator, or no media:read                               -> 403
//   original without a valid signature                          -> 403
//   unknown id, another site's id, deleted, no such file        -> 404
//   original with one                                           -> 200, attachment, no-store
//   thumbnail                                                   -> 200, private, max-age=300

/** How long a download link for an original works (brief #10 decision 10). */
export const ORIGINAL_TTL_MS = 10 * 60 * 1000;

/** What "download original" hands out: `original.<ext>`, or `file.<ext>` for a PDF or GIF. */
export function downloadFile(m: {
  contentType: string;
  variants: readonly { name: string; format: string }[];
}): string {
  const file = m.variants.find((v) => v.name === 'file');
  return file
    ? `file.${EXTENSION_OF[file.format as FileFormat]}`
    : `original.${EXTENSION_OF[FORMAT_OF[m.contentType as MediaContentType]]}`;
}

/** The admin URL of the original's download, signed until `expiresAt`. */
export async function signedOriginalPath(
  signer: Signer,
  tenantSlug: string,
  m: { id: string; contentType: string; variants: readonly { name: string; format: string }[] },
  expiresAt: Date
): Promise<string> {
  const signed = await appDelivery.signedVariantPath(signer, m.id, downloadFile(m), expiresAt);
  return `/admin/${tenantSlug}/media/${m.id}/original${signed.slice(signed.indexOf('?'))}`;
}

export async function serveAdminMedia(
  deps: MediaDeliveryDeps,
  /** The operator's principal for this tenant, or null without a session or membership. */
  principal: Principal | null,
  id: string,
  which: 'original' | 'thumb',
  url: URL
): Promise<Response> {
  if (!principal || !can(principal, 'media:read')) return status(403, 'private, no-store');
  if (!UUID.test(id)) return status(404);
  const media = await deps.uow.run(principal, (ctx) => ctx.media.get(id));
  if (!media || media.deletedAt || media.state !== 'ready') return status(404);

  const original = which === 'original';
  const file = original ? downloadFile(media) : 'thumb.webp';
  if (
    original &&
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
  if (!original && !media.variants.some((v) => variantFile(v) === file)) return status(404);

  const bytes = await deps.blobs.get(mediaKey(principal.tenantId, id, file));
  if (!bytes) {
    deps.log?.error('media: in the register but not in the store', { mediaId: id, file });
    return status(404);
  }
  const ext = file.slice(file.lastIndexOf('.') + 1);
  const format = (Object.keys(EXTENSION_OF) as FileFormat[]).find((f) => EXTENSION_OF[f] === ext);
  return new Response(new Uint8Array(bytes).buffer, {
    headers: {
      'content-type': CONTENT_TYPE_OF[format ?? 'png'],
      'content-length': String(bytes.length),
      'cache-control': original ? 'private, no-store' : 'private, max-age=300',
      'x-content-type-options': 'nosniff',
      ...(original ? { 'content-disposition': disposition(media.filename, 'attachment') } : {}),
    },
  });
}
