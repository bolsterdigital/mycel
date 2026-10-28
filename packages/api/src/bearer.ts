// The one bearer comparison of the HTTP front: `/metrics` and the platform API (TODO #53). The
// token is compared in constant time over SHA-256 digests, so the comparison takes as long
// whatever length the caller sends. Rejected: `timingSafeEqual` on the raw strings, which throws
// on a length difference and so tells the caller the token's length.

import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * True when `authorization` is `Bearer <token>` with exactly `expected`. No expected token means
 * nothing matches, so a route whose token is unset refuses everyone.
 */
export function bearerMatches(
  authorization: string | undefined,
  expected: string | undefined
): boolean {
  const presented = /^Bearer\s+(\S+)\s*$/i.exec(authorization ?? '')?.[1];
  if (!expected || !presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}
