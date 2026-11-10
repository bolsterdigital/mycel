// The values every copy of an erasure agrees on (ADR 019 rule 8, TODO #18d): the address a
// tombstone carries instead of the real one (the hash the register keeps instead of the address
// is `emailKey(..., 'erasure')` in email-key.ts). Shared by the memory and Postgres adapters so a restore on either finds the same rows.
// Rejected: storing the address in the register (it would be the one copy erasure never removes)
// and an HMAC under a key (a restore onto a box with another key could no longer match).

import { normalizeEmail } from '../util/email.js';
import { scrubText } from '../util/scrub.js';
import type { ConnectionIntentState } from '../connections/intents.js';
import type { ExportStatus } from '../tenants/exports.js';

/** `.invalid` is reserved (RFC 2606): a tombstone can never become a deliverable address. */
export const ERASED_DOMAIN = 'erased.invalid';

export const tombstoneEmail = (supporterId: string): string => `${supporterId}@${ERASED_DOMAIN}`;

export const isTombstone = (email: string): boolean => email.endsWith(`@${ERASED_DOMAIN}`);

/**
 * A registration no backup holds after this long is a warning (`ops.status.get`, `mycel erasures
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

/** Mail bodies can contain names, phone numbers or free text that an address scrub cannot find.
 * Delete those copies as a whole while preserving other events' existing redaction contract.
 */
export function eraseOutboxProps(
  type: string,
  props: Record<string, unknown>
): Record<string, unknown> {
  if (type === 'form.mail.planned') return {};
  const retained = { ...props };
  delete retained['confirmationCopy'];
  return JSON.parse(scrubText(JSON.stringify(retained))) as Record<string, unknown>;
}

// RFC-style local-part characters plus Unicode letters, marks and numbers. A substring of
// another mailbox (including a plus tag or a longer domain) is never grounds to delete its row.
const MAILBOX_CHAR = /[\p{L}\p{M}\p{N}.!#$%&'*+/=?^_`{|}~@-]/u;

/** Match decoded JSON strings and keys, including addresses embedded in free text. */
export function carriesErasedAddress(value: unknown, addresses: ReadonlySet<string>): boolean {
  if (typeof value === 'string') {
    const text = normalizeEmail(value);
    for (const address of addresses) {
      let start = text.indexOf(address);
      while (start !== -1) {
        const before = [...text.slice(Math.max(0, start - 2), start)].at(-1);
        const end = start + address.length;
        const after = [...text.slice(end, end + 2)][0];
        // A sentence's final period is punctuation; a dot followed by a mailbox character
        // continues the address (ann@example.org.evil must survive).
        const finalPeriod =
          after === '.' && !MAILBOX_CHAR.test([...text.slice(end + 1, end + 3)][0] ?? '');
        if (
          (!before || !MAILBOX_CHAR.test(before)) &&
          (!after || !MAILBOX_CHAR.test(after) || finalPeriod)
        )
          return true;
        start = text.indexOf(address, start + 1);
      }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((entry) => carriesErasedAddress(entry, addresses));
  return value !== null && typeof value === 'object'
    ? Object.entries(value).some(
        ([key, entry]) =>
          carriesErasedAddress(key, addresses) || carriesErasedAddress(entry, addresses)
      )
    : false;
}
