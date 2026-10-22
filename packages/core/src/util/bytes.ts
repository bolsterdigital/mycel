// Base64 to bytes with `atob`, a platform standard in Node, browsers and workers (ADR 001: not an
// I/O dependency). Rejected: Node's `Buffer`, which would tie the core to one runtime.

/** Standard base64 (with or without padding), as JSON carries an upload; throws on bad input. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The inverse, in chunks so a large file does not overflow the argument list. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
