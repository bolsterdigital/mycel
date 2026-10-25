// A checked DNS answer is pinned to a signed request; redirects and uncertain responses never
// become a second delivery. Fake sender avoids public network and personal data in the suite.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConnectionIntent, ConnectionRecord } from '@mycel/core';
import {
  checkedDestination,
  publicAddress,
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
