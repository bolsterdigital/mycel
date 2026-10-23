// The two values every copy of an erasure agrees on (ADR 019 rule 8, TODO #18d): the address a
// tombstone carries instead of the real one, and the hash the register keeps instead of the
// address. Shared by the memory and Postgres adapters so a restore on either finds the same rows.
// Rejected: storing the address in the register (it would be the one copy erasure never removes)
// and an HMAC under a key (a restore onto a box with another key could no longer match).

import { sha256Hex } from '../util/digest.js';

/** `.invalid` is reserved (RFC 2606): a tombstone can never become a deliverable address. */
export const ERASED_DOMAIN = 'erased.invalid';

export const tombstoneEmail = (supporterId: string): string => `${supporterId}@${ERASED_DOMAIN}`;

export const isTombstone = (email: string): boolean => email.endsWith(`@${ERASED_DOMAIN}`);

/** Hex `sha256(tenant id, newline, lower-case address)`; `encode(sha256(...))` in SQL is equal. */
export const erasureEmailHash = (tenantId: string, email: string): Promise<string> =>
  sha256Hex(`${tenantId}\n${email.trim().toLowerCase()}`);
