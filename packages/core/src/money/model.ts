// Money as Mycel records it (ADR 005): a payment is one attempt to move an amount, with the
// provider's reference and raw status beside our own status, and every change of that status is
// one append-only ledger entry with its cause. Amounts are integers in minor units with an ISO
// currency code, never floats (rule 1). The state machine is this file: a table of allowed steps
// and pure functions over it (rule 2); an adapter stores what the use cases decide and never
// moves a status itself.
//
// A provider reports where a payment stands now, not how it got there: a reconciliation that
// missed the webhook for `paid` may find `refunded`. `pathTo` answers with the steps in between,
// so the ledger records `open → paid → refunded` as two entries and everything that hangs on
// `paid` still happens once. A status the table cannot reach from here (a provider that says
// `open` about a payment we hold as `paid`) has no path and changes nothing.
//
// Rejected: a provider's own status vocabulary as ours (a second adapter would then change the
// ledger, rule 3; the raw status is kept beside it instead), `canceled` as a status of its own
// (ADR 005 names the set; a donor who backs out at the provider is a `failed` attempt whose raw
// status says why), and a generic "set status" with a list of forbidden pairs (a new status would
// be allowed everywhere until someone remembered to forbid it).

import { z } from 'zod';
import { Actor } from '../principal.js';

/** ISO 4217, upper case. */
export const Currency = z.string().regex(/^[A-Z]{3}$/);

/**
 * The currencies a payment may be in. One until a tenant chooses its own (ADR 005 rule 8: one
 * currency per tenant, no conversion); the column and the events carry the code from the start.
 */
export const SUPPORTED_CURRENCIES: readonly string[] = ['EUR'];

/** What one payment may move at most, in minor units: a typing slip must not become a charge. */
export const MAX_AMOUNT = 5_000_000;
/** Below this a provider's fee eats the gift. */
export const MIN_AMOUNT = 100;

export const MinorUnits = z.number().int().min(MIN_AMOUNT).max(MAX_AMOUNT);

export const PaymentStatus = z.enum([
  'created',
  'open',
  'paid',
  'failed',
  'expired',
  'refunded',
  'charged_back',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

/** Every step a payment may take (ADR 005 rule 2). A status without successors is final. */
export const PAYMENT_STEPS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  created: ['open', 'failed'],
  open: ['paid', 'failed', 'expired'],
  paid: ['refunded', 'charged_back'],
  failed: [],
  expired: [],
  refunded: [],
  charged_back: [],
};

export const canStep = (from: PaymentStatus, to: PaymentStatus): boolean =>
  PAYMENT_STEPS[from].includes(to);

/** Nothing can follow: a later report about this payment changes nothing. */
export const isFinal = (status: PaymentStatus): boolean => PAYMENT_STEPS[status].length === 0;

/**
 * The statuses to pass through from `from` to reach `to`, `to` included: empty when already
 * there, null when the table has no way. The shortest way, and the table is a tree, so the only one.
 */
export function pathTo(from: PaymentStatus, to: PaymentStatus): PaymentStatus[] | null {
  if (from === to) return [];
  const queue: PaymentStatus[][] = [[from]];
  for (const path of queue) {
    for (const next of PAYMENT_STEPS[path.at(-1)!]) {
      if (next === to) return [...path.slice(1), next];
      queue.push([...path, next]);
    }
  }
  return null;
}

/** What a payment is for. Subscriptions and memberships add kinds, not ledgers (rule 8). */
export const PaymentKind = z.enum(['donation']);
export type PaymentKind = z.infer<typeof PaymentKind>;

const Timestamp = z.string().datetime({ offset: true });

export const Payment = z.object({
  id: z.string().guid(),
  kind: PaymentKind,
  status: PaymentStatus,
  amount: MinorUnits,
  currency: Currency,
  /** What the donor reads at the provider and on a statement. Never an address or a name. */
  description: z.string().min(1).max(140),
  locale: z.string().min(2).max(35),
  /** The adapter that holds the other side of this payment. */
  provider: z.string().min(1).max(40),
  providerRef: z.string().min(1).max(200),
  /** The provider's own word for where the payment stands, as last heard. */
  providerStatus: z.string().max(60),
  /** Where the donor pays; null once the provider no longer offers it. */
  checkoutUrl: z.string().url().nullable(),
  /** The supporter who gives, when known; null for an anonymous gift and after an erasure. */
  supporterId: z.string().guid().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  paidAt: Timestamp.nullable(),
});
export type Payment = z.infer<typeof Payment>;

/** Why a status changed: who told us, not what they said. */
export const LedgerCause = z.enum(['checkout', 'return', 'webhook', 'reconcile', 'operator']);
export type LedgerCause = z.infer<typeof LedgerCause>;

export const LedgerEntry = z.object({
  id: z.string().guid(),
  paymentId: z.string().guid(),
  /** Null on the first entry of a payment. */
  from: PaymentStatus.nullable(),
  to: PaymentStatus,
  cause: LedgerCause,
  /** The provider's word at that moment. */
  providerStatus: z.string().max(60),
  amount: MinorUnits,
  currency: Currency,
  at: Timestamp,
  actor: Actor,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;
