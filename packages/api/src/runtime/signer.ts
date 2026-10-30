// HMAC-SHA256 implementation of the core `Signer` port. Token = base64url(payload).base64url(mac);
// the core decides what a payload contains and when it expires. Ported in spirit from
// dreamkit-supporter-registry/src/consent/tokens.ts. Rejected: JWT, whose header negotiation and
// algorithm zoo buy nothing for tokens only this application issues and reads.

import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { InputHasher, Signer } from '@mycel/core';

export class HmacSigner implements Signer {
  /**
   * The rate-limit key, derived as HKDF(SIGNING_SECRET, info 'ip') (TODO #74): an address hash is
   * never a MAC under the token key. Rejected: a second secret in the config, one more value a
   * self-hoster must generate for a key nobody reads.
   */
  readonly #ipKey: Buffer;

  constructor(private readonly secret: string) {
    if (secret.length < 16) throw new Error('SIGNING_SECRET must be at least 16 characters');
    this.#ipKey = Buffer.from(hkdfSync('sha256', secret, '', 'ip', 32));
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

  hashIp(ip: string): string {
    return createHmac('sha256', this.#ipKey).update(ip).digest('base64url').slice(0, 22);
  }
}

/**
 * The core `InputHasher` (TODO #17b decision 3): HMAC-SHA256 of an audit row's canonical input
 * under AUDIT_HASH_KEY, in hex. Keyed, because a plain hash of an input that is only an address
 * can be reversed with a word list; rotating the key makes older hashes unlinkable.
 */
export class HmacInputHasher implements InputHasher {
  constructor(private readonly key: string) {
    if (key.length < 16) throw new Error('AUDIT_HASH_KEY must be at least 16 characters');
  }

  async hash(canonical: string): Promise<string> {
    return createHmac('sha256', this.key).update(canonical).digest('hex');
  }
}
