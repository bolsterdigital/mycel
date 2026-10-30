// Random opaque tokens (API keys, hostname verification) via Web Crypto, a platform standard in
// Node, browsers and workers, so not an I/O dependency in the ADR 001 sense. Rejected: a Random
// port, which would be ceremony for one function with exactly one correct implementation.

import { bytesToBase64, bytesToHex } from './bytes.js';

const random = (bytes: number): Uint8Array =>
  globalThis.crypto.getRandomValues(new Uint8Array(bytes));

const base64url = (bytes: Uint8Array): string =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** `bytes` random bytes as base64url: 32 bytes give 43 characters and 256 bits of entropy. */
export function randomToken(bytes = 32): string {
  return base64url(random(bytes));
}

/** `bytes` random bytes as lowercase hex (a proof-of-work challenge). */
export const randomHex = (bytes: number): string => bytesToHex(random(bytes));
