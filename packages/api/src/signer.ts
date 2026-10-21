// HMAC-SHA256 implementation of the core `Signer` port. Token = base64url(payload).base64url(mac);
// the core decides what a payload contains and when it expires. Ported in spirit from
// dreamkit-supporter-registry/src/consent/tokens.ts. Rejected: JWT, whose header negotiation and
// algorithm zoo buy nothing for tokens only this application issues and reads.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Signer } from '@mycel/core';

export class HmacSigner implements Signer {
  constructor(private readonly secret: string) {
    if (secret.length < 16) throw new Error('SIGNING_SECRET must be at least 16 characters');
  }

  #mac(segment: string): Buffer {
    return createHmac('sha256', this.secret).update(segment).digest();
  }

  async sign(payload: string): Promise<string> {
    const segment = Buffer.from(payload, 'utf8').toString('base64url');
    return `${segment}.${this.#mac(segment).toString('base64url')}`;
  }

  async verify(token: string): Promise<string | null> {
    const dot = token.indexOf('.');
    if (dot <= 0) return null;
    const segment = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = this.#mac(segment);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return Buffer.from(segment, 'base64url').toString('utf8');
  }

  /** Keyed hash of an IP address: a stable rate-limit key that is not the address itself. */
  hashIp(ip: string): string {
    return createHmac('sha256', this.secret).update(`ip:${ip}`).digest('base64url').slice(0, 22);
  }
}
