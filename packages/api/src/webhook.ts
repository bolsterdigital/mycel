// Outbound webhook requests pin a freshly checked public DNS answer to the TLS connection. The
// address rule and the lookup are the core's (`checkDestination` over the DNS port), the same
// check the use cases run at configuration. Rejected: fetch(url), whose resolver and redirect
// handling can bypass an earlier IP check.
import { createHmac } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import {
  checkDestination,
  isSyntheticIntent,
  SYNTHETIC_SOURCE,
  type ConnectionTransport,
  type DnsResolver,
} from '@mycel/core';

export interface WebhookRequest {
  url: URL;
  address: string;
  body: string;
  headers: Readonly<Record<string, string>>;
}
export type WebhookSender = (request: WebhookRequest) => Promise<number>;

/** Both the socket idle timeout and the overall deadline of one delivery. */
const WEBHOOK_TIMEOUT_MS = 5000;

/** The checked address is used for TCP; URL hostname remains Host and TLS SNI. No redirect loop. */
export const sendWebhook = (
  { url, address, body, headers }: WebhookRequest,
  { ca }: Pick<RequestOptions, 'ca'> = {}
): Promise<number> =>
  new Promise((resolve, reject) => {
    const family = isIP(address);
    const fail = (error: Error) => {
      clearTimeout(deadline);
      // Settle directly: destroying an already-closed request need not emit another error.
      reject(error);
      request.destroy();
    };
    const request = httpsRequest(
      url,
      {
        method: 'POST',
        headers,
        ca,
        timeout: WEBHOOK_TIMEOUT_MS,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        },
      },
      (response) => {
        response.on('error', fail);
        response.on('close', () => {
          if (!response.complete) fail(new Error('webhook response closed before completion'));
        });
        response.on('end', () => {
          clearTimeout(deadline);
          resolve(response.statusCode ?? 0);
        });
        response.resume();
      }
    );
    const deadline = setTimeout(() => fail(new Error('webhook deadline')), WEBHOOK_TIMEOUT_MS);
    request.on('timeout', () => fail(new Error('webhook timeout')));
    request.on('error', fail);
    request.end(body);
  });

/**
 * No `reconcile`: a receiver gives no signed proof of what it did with an event, so an ambiguous
 * delivery stays `unknown` until an operator resolves it (`PROVIDER_RECONCILES.webhook`).
 */
export function webhookTransport({
  dns,
  send = sendWebhook,
  now = () => new Date(),
}: {
  dns: Pick<DnsResolver, 'addresses'>;
  send?: WebhookSender;
  now?: () => Date;
}): ConnectionTransport {
  return {
    async dispatch({ intent, connection, credential, payload }) {
      if (connection.provider !== 'webhook' || !connection.destination) return 'pre_send';
      // Only the synthetic source may be sent. A real payload needs its own reviewed,
      // category-specific contract before this transport accepts it.
      if (!isSyntheticIntent(intent) || payload['category'] !== SYNTHETIC_SOURCE) return 'pre_send';
      let target: Awaited<ReturnType<typeof checkDestination>>;
      try {
        target = await checkDestination(dns, connection.destination);
      } catch {
        return 'pre_send';
      }
      const timestamp = now().toISOString();
      const body = JSON.stringify({
        version: 'mycel.webhook.v1',
        eventId: intent.id,
        timestamp,
        idempotencyKey: intent.key,
        category: SYNTHETIC_SOURCE,
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
  };
}
