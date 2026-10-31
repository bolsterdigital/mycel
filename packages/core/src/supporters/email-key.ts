// The one place an e-mail address becomes a key (ADR 003, ADR 019 rule 8): every
// pseudonymous copy of an address (an admission seat, a rate-limit bucket, the erasure register,
// a mail correlation) is derived here from `normalizeEmail`, so an erasure can compute the key
// of every copy and a change to the normalisation reaches all of them at once. Adapters import
// this; none writes its own formula.
// Rejected: one formula for every purpose (the stored keys of admissions and the register differ
// and changing either would orphan rows a restore brings back), and keeping a helper per module
// (how four formulas came to exist, one of them without trim).

import { sha256Hex } from '../util/digest.js';
import { normalizeEmail } from '../util/email.js';

export type EmailKeyPurpose = 'admission' | 'rate-limit' | 'erasure' | 'mail-correlation';

/**
 * Hex sha256 of the tenant id and the normalised address. `admission` and `rate-limit` join with
 * `:`, `erasure` with a newline (`encode(sha256(...))` in packages/db/src/erasures.ts is equal),
 * and `mail-correlation` appends the subject, which a provider listing also shows.
 */
export function emailKey(
  tenantId: string,
  email: string,
  purpose: 'admission' | 'rate-limit' | 'erasure'
): Promise<string>;
export function emailKey(
  tenantId: string,
  email: string,
  purpose: 'mail-correlation',
  subject: string
): Promise<string>;
export function emailKey(
  tenantId: string,
  email: string,
  purpose: EmailKeyPurpose,
  subject?: string
): Promise<string> {
  const address = normalizeEmail(email);
  switch (purpose) {
    case 'admission':
    case 'rate-limit':
      return sha256Hex(`${tenantId}:${address}`);
    case 'erasure':
      return sha256Hex(`${tenantId}\n${address}`);
    case 'mail-correlation':
      return sha256Hex(`${tenantId}\n${address}\n${subject ?? ''}`);
  }
}
