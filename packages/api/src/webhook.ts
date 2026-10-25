// Outbound webhook requests pin a freshly checked public DNS answer to the TLS connection.
// Rejected: fetch(url), whose resolver and redirect handling can bypass an earlier IP check.
import { createHmac } from 'node:crypto';
import { resolve4, resolve6 } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { UseCaseError, type ConnectionTransport } from '@mycel/core';

const BLOCKED_V4 = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  BLOCKED_V4.addSubnet(address, bits, 'ipv4');
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const BLOCKED_V6 = new BlockList();
for (const [address, bits] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const)
  BLOCKED_V6.addSubnet(address, bits, 'ipv6');

export function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED_V4.check(address, 'ipv4');
  if (family === 6) return GLOBAL_V6.check(address, 'ipv6') && !BLOCKED_V6.check(address, 'ipv6');
  return false;
}

export type AddressLookup = (hostname: string) => Promise<string[]>;
export const dnsAddresses: AddressLookup = async (hostname) => {
  const results = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  const addresses = results.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : []
  );
  if (!addresses.length) throw new Error('webhook DNS did not return an address');
  return addresses;
};

/** Validation runs at configuration and for every attempt. A mixed public/private answer fails. */
export async function checkedDestination(
  raw: string,
  lookup: AddressLookup = dnsAddresses
): Promise<{ url: URL; address: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UseCaseError('invalid_input', 'invalid webhook destination');
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(host) ||
    !host.includes('.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  )
    throw new UseCaseError('invalid_input', 'webhook destination must be public HTTPS on port 443');
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new UseCaseError('invalid_input', 'webhook destination DNS unavailable');
  }
  if (!addresses.length || addresses.some((address) => !publicAddress(address)))
    throw new UseCaseError('invalid_input', 'webhook destination DNS is not public');
  return { url, address: addresses[0]! };
}

export interface WebhookRequest {
  url: URL;
  address: string;
  body: string;
  headers: Readonly<Record<string, string>>;
}
export type WebhookSender = (request: WebhookRequest) => Promise<number>;

/** The checked address is used for TCP; URL hostname remains Host and TLS SNI. No redirect loop. */
export const sendWebhook: WebhookSender = ({ url, address, body, headers }) =>
  new Promise((resolve, reject) => {
    const family = isIP(address);
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers,
        timeout: 5000,
        lookup: (_hostname, _options, callback) => callback(null, address, family),
      },
      (response) => {
        response.resume();
        response.on('end', () => {
          clearTimeout(deadline);
          resolve(response.statusCode ?? 0);
        });
      }
    );
    const deadline = setTimeout(() => request.destroy(new Error('webhook deadline')), 5000);
    request.on('timeout', () => request.destroy(new Error('webhook timeout')));
    request.on('error', (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end(body);
  });

export function webhookTransport({
  lookup = dnsAddresses,
  send = sendWebhook,
  now = () => new Date(),
}: {
  lookup?: AddressLookup;
  send?: WebhookSender;
  now?: () => Date;
} = {}): ConnectionTransport {
  return {
    async dispatch({ intent, connection, credential, payload }) {
      if (connection.provider !== 'webhook' || !connection.destination) return 'pre_send';
      // PR 1C has only a synthetic source. PR 2 adds reviewed, category-specific real payloads.
      if (intent.source !== 'synthetic.test' || payload['category'] !== 'synthetic.test')
        return 'pre_send';
      let target: Awaited<ReturnType<typeof checkedDestination>>;
      try {
        target = await checkedDestination(connection.destination, lookup);
      } catch {
        return 'pre_send';
      }
      const timestamp = now().toISOString();
      const body = JSON.stringify({
        version: 'mycel.webhook.v1',
        eventId: intent.id,
        timestamp,
        idempotencyKey: intent.key,
        category: 'synthetic.test',
        data: { synthetic: true },
      });
      const signature = createHmac('sha256', credential)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      try {
        const status = await send({
          ...target,
          body,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body)),
            'x-mycel-event-id': intent.id,
            'x-mycel-timestamp': timestamp,
            'x-mycel-signature': `sha256=${signature}`,
          },
        });
        return status >= 200 && status < 300 ? 'succeeded' : 'unknown';
      } catch {
        return 'unknown';
      }
    },
    async reconcile() {
      // A webhook receiver must deduplicate by eventId and may receive events out of order.
      // Without a signed receiver status proof an ambiguous delivery remains manual.
      return 'unknown';
    },
  };
}
