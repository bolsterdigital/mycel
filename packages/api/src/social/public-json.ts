// The provider runs on explicitly enabled HTTPS origins. Pin the checked address in TLS and use
// one fresh socket so redirects, pooled connections and a second DNS lookup cannot select a
// different destination. A provider may return bulky posts even when we only need two numbers.
import { checkDestination, type DnsResolver } from '@mycel/core';
import { request } from 'node:https';
import { isIP } from 'node:net';

const DEADLINE_MS = 4000;
const MAX_BYTES = 128 * 1024;

interface HttpResult {
  status: number;
  body?: unknown;
}

export type PublicJson = (url: URL) => Promise<HttpResult>;

export function publicJson(dns: Pick<DnsResolver, 'addresses'>): PublicJson {
  return async (endpoint) => {
    // The common check disallows URL-supplied query data. Our fixed XRPC parameters can be
    // appended after checking the origin and path.
    const destination = new URL(endpoint);
    destination.search = '';
    const { address } = await checkDestination(dns, destination.href);
    return new Promise<HttpResult>((resolve, reject) => {
      const family = isIP(address);
      const req = request(
        endpoint,
        {
          agent: false,
          signal: AbortSignal.timeout(DEADLINE_MS),
          headers: { accept: 'application/json' },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, [{ address, family }]);
            else callback(null, address, family);
          },
        },
        async (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200 && status !== 400) {
            response.destroy();
            resolve({ status });
            return;
          }
          try {
            const contentType = response.headers['content-type']?.split(';')[0]?.trim();
            if (contentType !== 'application/json') throw new Error('expected provider JSON');
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of response) {
              const buffer = Buffer.from(chunk);
              bytes += buffer.length;
              if (bytes > MAX_BYTES) throw new Error('provider response exceeds limit');
              chunks.push(buffer);
            }
            if (!response.complete) throw new Error('incomplete provider response');
            resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (error) {
            response.destroy();
            reject(error);
          }
        }
      );
      req.once('error', reject);
      req.end();
    });
  };
}
