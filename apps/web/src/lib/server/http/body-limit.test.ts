// Regression for media and brand uploads' raised body ceilings: neither chunking nor another action
// on the media page may raise the public-form limit. Accepted bytes must still parse normally.
import { expect, it } from 'vitest';
import { REPORTS_BODY, SMALL_BODY, bodyLimit, boundedBody } from './body-limit.js';

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

it('only raises multipart POST limits for the selected upload action', () => {
  for (const [path, method, type, expected] of [
    ['/admin/probe/media?/upload', 'POST', 'multipart/form-data; boundary=a', 26 * 1024 * 1024],
    ['/admin/probe/media?/update', 'POST', 'multipart/form-data; boundary=a', SMALL_BODY],
    ['/admin/probe/media?/delete&/upload', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/media?/upload', 'PUT', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/media?/upload', 'POST', 'application/x-www-form-urlencoded', SMALL_BODY],
    [
      '/admin/probe/site?/brand',
      'POST',
      'multipart/form-data; boundary=a',
      2 * 1024 * 1024 + 64 * 1024,
    ],
    ['/admin/probe/site/?/brand', 'POST', 'multipart/form-data', 2 * 1024 * 1024 + 64 * 1024],
    ['/admin/probe/site?/theme', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/site?/chrome&/brand', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/site?/brand', 'PUT', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/site?/brand', 'POST', 'application/x-www-form-urlencoded', SMALL_BODY],
    ['/admin/probe/media?/brand', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/signup?/brand', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/signup?/upload', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/media/upload', 'POST', 'multipart/form-data; boundary=a', 26 * 1024 * 1024],
    ['/admin/probe/media/upload?/delete', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/admin/probe/media/upload', 'POST', 'application/x-www-form-urlencoded', SMALL_BODY],
    ['/admin/probe/media/upload/x', 'POST', 'multipart/form-data', SMALL_BODY],
    ['/signup/media/upload', 'POST', 'multipart/form-data', SMALL_BODY],
  ] as const) {
    const url = new URL(path, 'http://localhost');
    const request = new Request(url, { method, headers: { 'content-type': type } });
    expect(bodyLimit(request, url)).toBe(expected);
  }
});

// Each native brand form carries one file. The transport ceiling includes bounded multipart
// overhead; the action and core still enforce the smaller, kind-specific file limits.
it.each([
  ['logo', 2 * 1024 * 1024],
  ['font', 1024 * 1024],
] as const)('preserves multipart %s bytes at the advertised file boundary', async (kind, size) => {
  const form = new FormData();
  form.set('kind', kind);
  form.set('baseVersion', '0');
  form.set('intent', 'upload');
  if (kind === 'font') form.set('licence', 'SIL Open Font License 1.1');
  form.set(
    'file',
    new File([new Uint8Array(size)], 'asset', {
      type: kind === 'logo' ? 'image/png' : 'font/woff2',
    })
  );
  const url = new URL('http://localhost/admin/probe/site?/brand');
  const request = new Request(url, { method: 'POST', body: form });
  const accepted = await boundedBody(request, bodyLimit(request, url));
  expect(accepted).not.toBeNull();
  expect(((await accepted!.formData()).get('file') as File).size).toBe(size);
});

it('bounds actual brand transport bytes even without a truthful Content-Length', async () => {
  const url = new URL('http://localhost/admin/probe/site?/brand');
  const ceiling = 2 * 1024 * 1024 + 64 * 1024;
  for (const length of [undefined, '1', String(ceiling + 1)]) {
    const headers: Record<string, string> = { 'content-type': 'multipart/form-data; boundary=a' };
    if (length) headers['content-length'] = length;
    const request = new Request(url, {
      method: 'POST',
      headers,
      body: new Uint8Array(ceiling + 1),
    });
    expect(await boundedBody(request, bodyLimit(request, url))).toBeNull();
  }
  const request = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=a' },
    body: new Uint8Array(ceiling),
  });
  expect(await boundedBody(request, bodyLimit(request, url))).not.toBeNull();
});

it('gives the browser reports far less room than a form', () => {
  const request = new Request('https://probe.example/_reports', { method: 'POST' });
  expect(bodyLimit(request, new URL(request.url))).toBe(REPORTS_BODY);
  expect(REPORTS_BODY).toBeLessThan(SMALL_BODY);
});
