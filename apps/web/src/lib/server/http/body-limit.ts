// Count actual bytes before a route parses a body. Content-Length is only an early refusal:
// chunked requests have no such header, so trusting it would raise every public form's limit
// when media uploads raise adapter-node's process-wide ceiling. Buffering is bounded by the
// route's limit. Stop reading on overflow; adapter-node drains the remainder after sending 413.
// Cancelling here destroys its socket before the client can receive that response.
export const SMALL_BODY = 512 * 1024;

export function bodyLimit(request: Request, url: URL): number {
  const action = [...url.searchParams.keys()].find((key) => key.startsWith('/'));
  const multipartPost =
    request.method === 'POST' &&
    request.headers.get('content-type')?.split(';')[0]?.trim() === 'multipart/form-data';
  if (!multipartPost) return SMALL_BODY;
  if (/^\/admin\/[^/]+\/media\/?$/.test(url.pathname) && action === '/upload')
    return 26 * 1024 * 1024;
  // The media picker's upload (brief media-picker): one file per request, the same ceiling.
  if (/^\/admin\/[^/]+\/media\/upload\/?$/.test(url.pathname) && action === undefined)
    return 26 * 1024 * 1024;
  // One brand file per native form: at most a 2 MiB logo (or 1 MiB font), plus 64 KiB
  // for multipart headers and fields. File-specific validation stays in the action/core.
  if (/^\/admin\/[^/]+\/site\/?$/.test(url.pathname) && action === '/brand')
    return 2 * 1024 * 1024 + 64 * 1024;
  return SMALL_BODY;
}

/** Return a replayable request, or null for 413, including bodies without Content-Length. */
export async function boundedBody(request: Request, limit: number): Promise<Request | null> {
  if (Number(request.headers.get('content-length')) > limit) {
    return null;
  }
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Request(request, { body: bytes });
}
