// Hashing via Web Crypto (`globalThis.crypto.subtle`): a platform standard available in Node,
// browsers and workers, so it is not an I/O dependency in the ADR 001 sense. Rejected: a Hasher
// port, which would be ceremony for a pure function with exactly one correct implementation.

import { bytesToHex } from './bytes.js';

async function hex(algorithm: 'SHA-1' | 'SHA-256', input: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(algorithm, new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export const sha1Hex = (input: string): Promise<string> => hex('SHA-1', input);
export const sha256Hex = (input: string): Promise<string> => hex('SHA-256', input);

/** SHA-256 of raw bytes (a media checksum), as lowercase hex. */
export async function sha256HexOfBytes(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}
