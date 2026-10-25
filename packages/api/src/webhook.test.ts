// A checked DNS answer is pinned to a signed request; redirects and uncertain responses never
// become a second delivery. A local TLS server exercises Node's real lookup callback.
import { performance } from 'node:perf_hooks';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ConnectionIntent, ConnectionRecord } from '@mycel/core';
import {
  checkedDestination,
  publicAddress,
  sendWebhook,
  webhookTransport,
  type WebhookRequest,
} from './webhook.js';

const intent = {
  id: '01900000-0000-7000-8000-000000000001',
  key: 'stable-key',
  source: 'synthetic.test',
  supporterId: null,
  scope: 'synthetic:test',
} as ConnectionIntent;
const connection = {
  provider: 'webhook',
  destination: 'https://hooks.example.org/mycel',
} as ConnectionRecord;
const payload = { category: 'synthetic.test' };

describe('webhook destination and transport', () => {
  it('sends over TLS to the pinned address and checks the URL hostname certificate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mycel-webhook-tls-'));
    const keyPath = join(directory, 'key.pem');
    const certPath = join(directory, 'cert.pem');
    try {
      execFileSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-subj',
          '/CN=hooks.example.org',
          '-addext',
          'subjectAltName=DNS:hooks.example.org',
        ],
        { stdio: 'ignore' }
      );
      const paths: string[] = [];
      const received: { address?: string; host?: string; body?: string } = {};
      const server = createServer(
        { key: readFileSync(keyPath), cert: readFileSync(certPath) },
        (request, response) => {
          received.address = request.socket.remoteAddress;
          received.host = request.headers.host;
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            received.body = Buffer.concat(chunks).toString('utf8');
            paths.push(request.url!);
            if (request.url === '/truncated') {
              response.writeHead(200, { 'content-length': '100' });
              response.write('x', () => response.destroy());
            } else if (request.url === '/trickle') {
              response.writeHead(200);
              response.write('x');
              const interval = setInterval(() => response.write('x'), 100);
              response.on('close', () => clearInterval(interval));
            } else if (request.url === '/redirect') {
              response.writeHead(302, { location: '/mycel' }).end();
            } else {
              response.writeHead(204).end();
            }
          });
        }
      );
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('no TLS test port');
        const status = await sendWebhook(
          {
            url: new URL(`https://hooks.example.org:${address.port}/mycel`),
            address: '127.0.0.1',
            body: '{"synthetic":true}',
            headers: { 'content-type': 'application/json' },
          },
          { ca: readFileSync(certPath) }
        );
        expect(status).toBe(204);
        expect(received).toEqual({
          address: '127.0.0.1',
          host: `hooks.example.org:${address.port}`,
          body: '{"synthetic":true}',
        });
        await expect(
          sendWebhook(
            {
              url: new URL(`https://other.example.org:${address.port}/mycel`),
              address: '127.0.0.1',
              body: '{}',
              headers: {},
            },
            { ca: readFileSync(certPath) }
          )
        ).rejects.toThrow('Hostname/IP does not match certificate');
        const send = (path: string, trusted = true) =>
          sendWebhook(
            {
              url: new URL(`https://hooks.example.org:${address.port}${path}`),
              address: '127.0.0.1',
              body: '{}',
              headers: {},
            },
            trusted ? { ca: readFileSync(certPath) } : {}
          );
        await expect(send('/untrusted', false)).rejects.toThrow();
        expect(paths).toEqual(['/mycel']);
        expect(await send('/redirect')).toBe(302);
        expect(paths).toEqual(['/mycel', '/redirect']);

        // A receiver can accept headers/body before dropping the socket. This must release
        // the sequential worker promptly, while preserving the ambiguous delivery outcome.
        const transport = webhookTransport({
          lookup: async () => ['8.8.8.8'],
          send: () => send('/truncated'),
        });
        const started = performance.now();
        expect(
          await transport.dispatch({
            tenantId: 'tenant',
            intent,
            connection,
            credential: 'synthetic-secret',
            payload,
          })
        ).toBe('unknown');
        expect(performance.now() - started).toBeLessThan(2000);
        expect(paths.filter((path) => path === '/truncated')).toHaveLength(1);
        expect(await transport.reconcile({ tenantId: 'tenant', intent })).toBe('unknown');
        expect(paths.filter((path) => path === '/truncated')).toHaveLength(1);

        // Activity defeats the socket inactivity timeout, but never the total deadline.
        const deadlineStarted = performance.now();
        await expect(send('/trickle')).rejects.toThrow('webhook deadline');
        expect(performance.now() - deadlineStarted).toBeGreaterThanOrEqual(4900);
        expect(performance.now() - deadlineStarted).toBeLessThan(6500);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 10000);

  it('rejects local, metadata, mapped IPv6, mixed DNS and non-HTTPS destinations', async () => {
    for (const address of [
      '127.0.0.1',
      '10.2.3.4',
      '169.254.169.254',
      '::1',
      'fc00::1',
      '::ffff:127.0.0.1',
      '2001:db8::1',
    ])
      expect(publicAddress(address)).toBe(false);
    expect(publicAddress('8.8.8.8')).toBe(true);
    expect(publicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of [
      'http://hooks.example.org',
      'https://127.0.0.1/',
      'https://hooks.example.org:8443/',
      'https://localhost/',
    ])
      await expect(checkedDestination(url, async () => ['8.8.8.8'])).rejects.toThrow();
    await expect(
      checkedDestination(connection.destination!, async () => ['8.8.8.8', '169.254.169.254'])
    ).rejects.toThrow();
  });

  it('checks DNS again for delivery, signs a stable envelope, and pins the checked address', async () => {
    let addresses = ['8.8.8.8'];
    const sent: WebhookRequest[] = [];
    const transport = webhookTransport({
      lookup: async () => addresses,
      now: () => new Date('2026-10-25T12:00:00.000Z'),
      send: async (request) => {
        sent.push(request);
        return 204;
      },
    });
    const input = {
      tenantId: 'tenant',
      intent,
      connection,
      credential: 'synthetic-secret',
      payload,
    };
    expect(await transport.dispatch(input)).toBe('succeeded');
    expect(sent[0]?.address).toBe('8.8.8.8');
    expect(sent[0]?.url.hostname).toBe('hooks.example.org');
    const body = JSON.parse(sent[0]!.body);
    expect(body).toMatchObject({
      version: 'mycel.webhook.v1',
      eventId: intent.id,
      idempotencyKey: intent.key,
      category: 'synthetic.test',
      data: { synthetic: true },
    });
    expect(JSON.stringify(body)).not.toContain('synthetic-secret');
    expect(sent[0]?.headers['x-mycel-signature']).toBe(
      'sha256=' +
        createHmac('sha256', 'synthetic-secret')
          .update(`2026-10-25T12:00:00.000Z.${sent[0]!.body}`)
          .digest('hex')
    );
    addresses = ['127.0.0.1'];
    expect(await transport.dispatch(input)).toBe('pre_send');
    expect(sent).toHaveLength(1);
    expect(await transport.reconcile({ tenantId: 'tenant', intent })).toBe('unknown');
  });

  it('keeps redirects, timeouts and dropped connections uncertain', async () => {
    for (const send of [
      async () => 302,
      async () => 504,
      async () => {
        throw new Error('closed');
      },
    ]) {
      const transport = webhookTransport({ lookup: async () => ['8.8.8.8'], send });
      expect(
        await transport.dispatch({
          tenantId: 'tenant',
          intent,
          connection,
          credential: 'synthetic-secret',
          payload,
        })
      ).toBe('unknown');
    }
  });
});
