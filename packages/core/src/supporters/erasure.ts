// The two values every copy of an erasure agrees on (ADR 019 rule 8, TODO #18d): the address a
// tombstone carries instead of the real one, and the hash the register keeps instead of the
// address. Shared by the memory and Postgres adapters so a restore on either finds the same rows.
// Rejected: storing the address in the register (it would be the one copy erasure never removes)
// and an HMAC under a key (a restore onto a box with another key could no longer match).

import type { ConnectionIntentState } from '../connections/intents.js';
import type { ExportStatus } from '../tenants/exports.js';
import { sha256Hex } from '../util/digest.js';

/** `.invalid` is reserved (RFC 2606): a tombstone can never become a deliverable address. */
export const ERASED_DOMAIN = 'erased.invalid';

export const tombstoneEmail = (supporterId: string): string => `${supporterId}@${ERASED_DOMAIN}`;

export const isTombstone = (email: string): boolean => email.endsWith(`@${ERASED_DOMAIN}`);

/** Hex `sha256(tenant id, newline, lower-case address)`; `encode(sha256(...))` in SQL is equal. */
export const erasureEmailHash = (tenantId: string, email: string): Promise<string> =>
  sha256Hex(`${tenantId}\n${email.trim().toLowerCase()}`);

/**
 * A registration no backup holds after this long is a warning (`ops.status`, `mycel erasures
 * status`, TODO #29B): the `erasures` backup runs every 15 minutes, so an hour is four missed runs.
 */
export const ERASURE_UNSECURED_WARN_MS = 60 * 60 * 1000;

// What apply does to the rows that are not scrubbed but changed (TODO #53 PR 3). Both adapters
// call these, so the in-memory tests prove the rule production runs.

/**
 * A connection intent of an erased supporter loses its supporter reference. A state that already
 * says what happened at the provider stays, so an erasure never claims an effect was undone;
 * every other state becomes `blocked`, so no further attempt carries the person.
 */
export const ERASURE_KEEPS_INTENT_STATES = [
  'unknown',
  'succeeded',
  'resolved',
] as const satisfies readonly ConnectionIntentState[];

export const erasedIntentState = (state: ConnectionIntentState): ConnectionIntentState =>
  (ERASURE_KEEPS_INTENT_STATES as readonly string[]).includes(state) ? state : 'blocked';

/** The export statuses whose archive may hold a registered person (TODO #28). */
export const ERASURE_EXPIRES_EXPORTS = [
  'running',
  'ready',
] as const satisfies readonly ExportStatus[];
export const ERASURE_EXPORT_ERROR = 'deleted after an erasure';

/**
 * ADR 019 rule 8: an archive is a copy too. Expire every archive built or building while this
 * apply found something to erase, and any asked for before the newest registration.
 */
export const expiresOnErasure = (
  record: { status: ExportStatus; requestedAt: Date },
  changedRows: boolean,
  newestErasure: Date
): boolean =>
  (ERASURE_EXPIRES_EXPORTS as readonly string[]).includes(record.status) &&
  (changedRows || record.requestedAt < newestErasure);
