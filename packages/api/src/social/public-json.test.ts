import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { request, type RequestOptions } from 'node:https';
import { beforeEach, expect, it, vi } from 'vitest';
import { publicJson } from './public-json.js';

vi.mock('node:https', () => ({ request: vi.fn() }));
const requests = vi.mocked(request);
const endpoint = new URL('https://public.example.org/xrpc/read?key=local-only');
const publicAnswer = '8.8.8.8';

function answer(statusCode: number, body: Buffer[] = []) {
  requests.mockImplementationOnce(((
    _url: URL,
    _options: RequestOptions,
    respond: (response: unknown) => void
  ) => {
    const response = Object.assign(Readable.from(body), {
      statusCode,
      complete: true,
      headers: { 'content-type': 'application/json', location: 'https://another.example.org/' },
    });
    const req = Object.assign(new EventEmitter(), { end: () => respond(response) });
    return req;
  }) as unknown as typeof request);
}

beforeEach(() => requests.mockReset());

it('refuses nonpublic DNS answers before opening a socket', async () => {
  const get = publicJson({ addresses: async () => [publicAnswer, '127.0.0.1'] });
  await expect(get(endpoint)).rejects.toThrow('DNS is not public');
  expect(requests).not.toHaveBeenCalled();
});

it('pins the work to the checked address and never follows a redirect', async () => {
  answer(302);
  const resolve = vi.fn(async () => [publicAnswer]);
  const get = publicJson({ addresses: resolve });
  expect(await get(endpoint)).toEqual({ status: 302 });
  expect(resolve).toHaveBeenCalledExactlyOnceWith('public.example.org');
  expect(requests).toHaveBeenCalledTimes(1);
  const [url, options] = requests.mock.calls[0] as unknown as [URL, RequestOptions];
  expect(url.href).toBe(endpoint.href);
  expect(options.agent).toBe(false);
  expect(options.signal).toBeInstanceOf(AbortSignal);
  const received = vi.fn();
  options.lookup?.('public.example.org', { all: true }, received);
  expect(received).toHaveBeenCalledExactlyOnceWith(null, [{ address: publicAnswer, family: 4 }]);
});

it('caps bytes actually read even without Content-Length', async () => {
  const get = publicJson({ addresses: async () => [publicAnswer] });
  answer(200, [Buffer.from('{"count":0}')]);
  await expect(get(endpoint)).resolves.toEqual({ status: 200, body: { count: 0 } });
  answer(
    200,
    Array.from({ length: 129 }, () => Buffer.alloc(1024))
  );
  await expect(get(endpoint)).rejects.toThrow('exceeds limit');
});
