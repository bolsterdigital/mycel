// Real fetch requests prove the adapter's HTTP boundary, including a stalled body and redirects.
// Rejected: a success-only stub which cannot exercise connection lifetime or response limits.
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createMailchimpRequester } from './client.js';
import { loadConfig } from '../runtime/config.js';

describe('Mailchimp HTTP boundary', () => {
  it('uses authorization, refuses redirects and caps complete response bodies', async () => {
    const requests: { url: string; authorization?: string }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url!,
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      });
      if (request.url === '/3.0/redirect')
        response.writeHead(302, { location: '/3.0/destination' }).end();
      else if (request.url === '/3.0/large') response.end('x'.repeat(1024 * 1024 + 1));
      else response.end(JSON.stringify({ account_id: 'synthetic' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    const send = createMailchimpRequester(`http://127.0.0.1:${address.port}`);
    const input = { server: 'us7', credential: 'synthetic-only', method: 'GET' as const };
    try {
      expect((await send({ ...input, path: '/' })).body).toEqual({ account_id: 'synthetic' });
      expect(requests[0]!.authorization).toBe(
        `Basic ${Buffer.from('mycel:synthetic-only').toString('base64')}`
      );
      await expect(send({ ...input, path: '/redirect' })).rejects.toThrow();
      expect(requests.some((r) => r.url === '/3.0/destination')).toBe(false);
      await expect(send({ ...input, path: '/large' })).rejects.toThrow(
        'provider response too large'
      );
      await expect(send({ ...input, server: 'us7.evil.test', path: '/' })).rejects.toThrow();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it('ends a response that stalls after headers within the total deadline', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.write('{');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture listener missing');
    const send = createMailchimpRequester(`http://127.0.0.1:${address.port}`);
    const started = performance.now();
    try {
      await expect(
        send({ server: 'us7', credential: 'synthetic', method: 'GET', path: '/' })
      ).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(6500);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
  it('rejects a nonloopback fixture and refuses every fixture in production', () => {
    expect(() => createMailchimpRequester('https://example.org')).toThrow();
    expect(() =>
      loadConfig({
        APP_DATABASE_URL: 'postgres://app@localhost/test',
        AUTH_DATABASE_URL: 'postgres://auth@localhost/test',
        SIGNING_SECRET: 'test-only-signing-secret',
        PUBLIC_BASE_URL: 'https://example.org',
        MAIL_FROM: 'mail@example.org',
        PLATFORM_DOMAIN: 'example.org',
        NODE_ENV: 'production',
        MAILCHIMP_FIXTURE_ORIGIN: 'http://127.0.0.1:8995',
      })
    ).toThrow();
  });
});
