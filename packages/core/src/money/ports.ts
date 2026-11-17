// What the money module needs from outside (ADR 005 rule 3). `PaymentProvider` is the whole
// surface a provider adapter implements for a one-off payment: open a checkout, say where a
// payment stands. It answers in the five outcomes the state machine knows plus its own word for
// it, so the core never reads a provider's vocabulary; a second adapter changes nothing here.
// Mandates and charging one are added to this port with recurring giving, not before.
//
// The provider sits on the transaction context, like the DNS resolver: opening a checkout moves
// no money (the donor does that, at the provider, later), so a transaction that fails after the
// call leaves an unpaid checkout nobody was sent to, and asking for a status is a read. Charging a
// mandate is different, an effect that cannot be taken back, and gets an intent row and a key
// before the call when it is built (ADR 019 rule 6). Rejected: three transactions around every
// provider call from the start, as mail does: correct for an irreversible send, machinery without
// a failure to prevent for a checkout.

import type { LedgerEntry, Payment, PaymentStatus } from './model.js';

/** Where a payment stands at the provider, in the state machine's words. */
export type ProviderOutcome = Exclude<PaymentStatus, 'created'>;

export interface ProviderPayment {
  ref: string;
  outcome: ProviderOutcome;
  /** The provider's own status word, kept beside ours. */
  raw: string;
  checkoutUrl: string | null;
}

export interface CheckoutRequest {
  /** Our payment id: the provider's idempotency key, so a repeated call opens one checkout. */
  key: string;
  amount: number;
  currency: string;
  description: string;
  /** Where the provider sends the donor afterwards. */
  returnUrl: string;
  locale: string;
}

export interface PaymentProvider {
  /** Stable name of the adapter, stored with each payment. */
  readonly id: string;
  /** Throws when the provider refuses or cannot be reached. */
  createCheckout(request: CheckoutRequest): Promise<ProviderPayment>;
  /** Null when the provider does not know the reference. Throws when it cannot be reached. */
  fetchPayment(ref: string): Promise<ProviderPayment | null>;
}

export interface PaymentFilter {
  status?: PaymentStatus | undefined;
  supporterId?: string | undefined;
}

export interface PaymentRepository {
  insert(payment: Payment): Promise<void>;
  get(id: string): Promise<Payment | null>;
  /** The payment, locked for the rest of the transaction: two reports about it run in turn. */
  lock(id: string): Promise<Payment | null>;
  /**
   * Writes what a step changes: status, the provider's word, the checkout, the times, and the
   * supporter a settling step found for a payment that named only its submission.
   */
  save(payment: Payment): Promise<void>;
  /** Newest first. */
  list(filter: PaymentFilter, offset: number, limit: number): Promise<Payment[]>;
  /**
   * What the paid payments of each campaign add up to in `currency`, and how many there are;
   * absent ids raised nothing. A refunded or charged-back payment is no longer `paid`.
   */
  raised(
    campaignIds: readonly string[],
    currency: string
  ): Promise<Map<string, { amount: number; gifts: number }>>;
  /** Payments not yet settled (`created`, `open`) and unchanged since `before`, oldest first. */
  due(before: string, limit: number): Promise<Payment[]>;
  /** Append-only: an entry is never changed or removed. */
  appendLedger(entry: LedgerEntry): Promise<void>;
  /** In the order the entries were appended; one walk writes several with the same `at`. */
  ledger(paymentId: string): Promise<LedgerEntry[]>;
}

declare module '../ports.js' {
  interface TransactionContext {
    payments: PaymentRepository;
    /** Null when this installation has no payment provider: nothing can be started. */
    paymentProvider: PaymentProvider | null;
  }
}
