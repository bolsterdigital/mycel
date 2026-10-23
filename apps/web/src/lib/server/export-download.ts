// The download of an export archive (TODO #28, brief tenant-self-export § 4): the operator's
// session, a current `tenant:admin` membership of the site in the path, and a five-minute signed
// link from the export page, all required. `openExportDownload` in core decides and audits; this
// file turns its answer into a response and streams the archive out of the blob store. Every
// refusal is the same 404: an unknown id, another site's id, a bad or old link, a member without
// `tenant:admin` and an operator without a membership cannot be told apart from outside.
// Rejected: a 403 for a missing session (it would confirm that the archive exists) and the bytes
// in memory (an archive can be gigabytes).
import {
  exportFilename,
  openExportDownload,
  type BlobStore,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';

export interface ExportDownloadDeps {
  uow: UnitOfWork;
  blobs: BlobStore;
}

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'cache-control': 'private, no-store', 'content-type': 'text/plain; charset=utf-8' },
  });

/** An async iterable of chunks as a web stream, pulled one chunk at a time. */
function toStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export async function serveExportDownload(
  deps: ExportDownloadDeps,
  /** The operator's principal for this site, or null without a session or membership. */
  principal: Principal | null,
  slug: string,
  id: string,
  url: URL,
  requestId: string | null = null
): Promise<Response> {
  if (!principal) return notFound();
  const download = await deps.uow.run(principal, (ctx) =>
    openExportDownload(
      ctx,
      { id, exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') },
      requestId
    )
  );
  if (!download) return notFound();
  const stream = await deps.blobs.getStream(download.key);
  if (!stream) return notFound();
  const headers: Record<string, string> = {
    'content-type': 'application/x-tar',
    'content-disposition': `attachment; filename="${exportFilename(slug, download.record)}"`,
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
  };
  if (download.record.sizeBytes !== null)
    headers['content-length'] = String(download.record.sizeBytes);
  return new Response(toStream(stream), { headers });
}
