// Regression for the media admin's raised body ceiling: neither chunking nor another action
// on the media page may raise the public-form limit. Accepted bytes must still parse normally.
import { expect, it } from 'vitest';
import { SMALL_BODY, bodyLimit, boundedBody } from './body-limit.js';

it('stops reading chunked bytes on overflow, even with a falsely small length', async () => {
  for (const length of [undefined, '1']) {
    let reads = 0;
    const request = new Request('http://localhost/signup', {
      method: 'POST',
      headers: length ? { 'content-length': length } : {},
      body: new ReadableStream({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(128 * 1024));
        },
      }),
      duplex: 'half',
    } as RequestInit);
    expect(await boundedBody(request, SMALL_BODY)).toBeNull();
    // Four chunks fit; the fifth overflows and the stream may prefetch one more.
    expect(reads).toBeLessThanOrEqual(6);
  }
});

it('preserves a form at the exact boundary for the route to parse', async () => {
  const body = `value=${'a'.repeat(SMALL_BODY - 6)}`;
  const request = new Request('http://localhost/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const accepted = await boundedBody(request, SMALL_BODY);
  expect((await accepted!.formData()).get('value')).toBe(body.slice(6));
});

it('only raises the limit for a multipart POST whose selected action is upload', () => {
  for (const [path, method, type, expected] of [
    ['/admin/probe/media?/upload', 'POST', 'multipart/form-data; boundary=a', 26 * 1024 * 1024],
    ['/admin/probe/media?/update', 'POST', 'multipart/form-data; boundary=a', SMALL_BODY],
    ['/admin/probe/media?/delete&/upload', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/media?/upload', 'PUT', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/media?/upload', 'POST', 'application/x-www-form-urlencoded', SMALL_BODY],
    ['/signup?/upload', 'POST', 'multipart/form-data', SMALL_BODY],
  ] as const) {
    const url = new URL(path, 'http://localhost');
    const request = new Request(url, { method, headers: { 'content-type': type } });
    expect(bodyLimit(request, url)).toBe(expected);
  }
});
