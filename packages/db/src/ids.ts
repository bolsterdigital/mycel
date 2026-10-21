// UUIDv7 (RFC 9562): 48-bit Unix milliseconds, version, 74 random bits. Fifteen lines of our own
// code instead of the `uuid` package (ADR 008 policy 1); Node has no native v7 yet.

import { randomBytes } from 'node:crypto';
import type { Ids } from '@mycel/core';

export function uuidv7(now: number = Date.now()): string {
  const b = randomBytes(16);
  let ms = BigInt(now);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const uuidv7Ids: Ids = { next: () => uuidv7() };
