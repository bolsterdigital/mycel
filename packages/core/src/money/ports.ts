// What the money module needs from outside (ADR 005 rule 3). `PaymentProvider` is the whole
// surface a provider adapter implements: open a checkout, say where a payment stands, and, for
// recurring giving, charge a mandate and find a charge by its key. It answers in the five
// outcomes the state machine knows plus its own word for it, so the core never reads a provider's
// vocabulary; a second adapter changes nothing here. The two recurring methods are optional: an
// adapter without them takes one-off gifts and refuses a subscription. `findCharge` gets the
// mandate's references beside the key, because a provider that cannot look a payment up by our
// key (Mollie) can only be certain it made none by reading every payment of that customer.
// `chargeMandate` has three answers: a payment, a refusal (the provider declined with certainty
// and made nothing, so the attempt is a failed one and dunning runs, MY-255), or a throw (it may
// or may not have charged). The refusal is a value, not an error class, so the caller's type
// forces it to handle it. Rejected: a `ChargeRefusedError` the adapter throws (a missed
// `instanceof` silently turns a refusal back into the endless `unknown` it replaced).
//
// The provider sits on the transaction context, like the DNS resolver: opening a checkout moves
// no money (the donor does that, at the provider, later), so a transaction that fails after the
// call leaves an unpaid checkout nobody was sent to, and asking for a status is a read. Charging a
// mandate is different, an effect that cannot be taken back: `subscriptions.ts` writes an intent
// row with a key in a transaction of its own first, makes the call in another, and records the
// answer in a third (ADR 019 rule 6). Rejected: three transactions around every provider call, as
// mail does: correct for an irreversible charge, machinery without a failure to prevent for a
// checkout.

import type { LedgerEntry, Payment, PaymentStatus } from './model.js';
import type {
  ChargeAttempt,
  Mandate,
  Subscription,
  SubscriptionKind,
  SubscriptionLedgerEntry,
  SubscriptionStatus,
} from './subscription-model.js';

/** Where a payment stands at the provider, in the state machine's words. */
export type ProviderOutcome = Exclude<PaymentStatus, 'created'>;

export interface ProviderPayment {
  ref: string;
  outcome: ProviderOutcome;
  /** The provider's own status word, kept beside ours. */
  raw: string;
  checkoutUrl: string | null;
  /**
   * The mandate a paid first payment left, when the provider made one: what a later charge
   * names. Absent for a one-off payment and while the provider has not decided.
   */
  mandate?: ProviderMandate | undefined;
}

export interface ProviderMandate {
  customerRef: string;
  mandateRef: string;
  /** The provider's word for how it charges (`directdebit`, `creditcard`). */
  method: string;
  valid: boolean;
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
  /** `first` asks the donor for a mandate as well (a subscription's first payment). */
  sequence: 'oneoff' | 'first';
  /**
   * The donor's address, on a first payment only: a mandate belongs to a customer at the
   * provider, which knows them by it (MY-254). A one-off gift sends none.
   */
  email?: string | undefined;
}

export interface ChargeRequest {
  /** The charge attempt's key: the provider's idempotency key, so a repeat charges once. */
  key: string;
  /** Our id for the payment this charge becomes, for the provider's metadata and webhook. */
  paymentId: string;
  customerRef: string;
  mandateRef: string;
  amount: number;
  currency: string;
  description: string;
  locale: string;
}

/**
 * The provider declined a charge with certainty and made no payment for it: about the giver's
 * mandate, never the site's key or connection (those throw). `raw` is the provider's word.
 */
export interface ChargeRefusal {
  refused: true;
  raw: string;
}

/** What a charge attempt is found by: its key, and the mandate it was charged against. */
export type FindChargeRequest = Pick<ChargeRequest, 'key' | 'customerRef' | 'mandateRef'>;

export interface PaymentProvider {
  /** Stable name of the adapter, stored with each payment. */
  readonly id: string;
  /** Throws when the provider refuses or cannot be reached. */
  createCheckout(request: CheckoutRequest): Promise<ProviderPayment>;
  /** Null when the provider does not know the reference. Throws when it cannot be reached. */
  fetchPayment(ref: string): Promise<ProviderPayment | null>;
  /**
   * Charge a mandate without the donor. A `ChargeRefusal` when the provider declined with
   * certainty and made nothing. Throws when it cannot be reached, cannot be certain, or refuses
   * the site itself (a wrong key); the caller then asks `findCharge` before trying again.
   */
  chargeMandate?(request: ChargeRequest): Promise<ProviderPayment | ChargeRefusal>;
  /**
   * The charge made with `key`, or null only when the provider is certain it made none for it.
   * Throws when it cannot be reached or cannot be certain; the attempt then waits for a later run.
   */
  findCharge?(request: FindChargeRequest): Promise<ProviderPayment | null>;
}

export interface PaymentFilter {
  status?: PaymentStatus | undefined;
  supporterId?: string | undefined;
  subscriptionId?: string | undefined;
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

export interface SubscriptionFilter {
  status?: SubscriptionStatus | undefined;
  kind?: SubscriptionKind | undefined;
  supporterId?: string | undefined;
  /** The memberships of one paid tier (MY-254 PR 4). */
  tierId?: string | undefined;
}

export interface SubscriptionRepository {
  insert(subscription: Subscription): Promise<void>;
  get(id: string): Promise<Subscription | null>;
  /** The subscription, locked for the rest of the transaction. */
  lock(id: string): Promise<Subscription | null>;
  /** Writes what a step changes; kind, amount, interval, provider and tier are fixed at insert. */
  save(subscription: Subscription): Promise<void>;
  /** Newest first. */
  list(filter: SubscriptionFilter, offset: number, limit: number): Promise<Subscription[]>;
  /** Active subscriptions whose next charge is due at `now`, earliest first. */
  due(now: string, limit: number): Promise<Subscription[]>;
  /** Append-only, numbered after the last entry of its subscription. */
  appendLedger(entry: SubscriptionLedgerEntry): Promise<void>;
  /** In the order the entries were appended. */
  ledger(subscriptionId: string): Promise<SubscriptionLedgerEntry[]>;
  insertMandate(mandate: Mandate): Promise<void>;
  getMandate(id: string): Promise<Mandate | null>;
  insertAttempt(attempt: ChargeAttempt): Promise<void>;
  getAttempt(key: string): Promise<ChargeAttempt | null>;
  /** Writes `status` and `updatedAt`. */
  saveAttempt(attempt: ChargeAttempt): Promise<void>;
  /** Every attempt of a subscription, oldest first. */
  attempts(subscriptionId: string): Promise<ChargeAttempt[]>;
  /** The attempt whose payment this is, if a charge made it. */
  attemptOfPayment(paymentId: string): Promise<ChargeAttempt | null>;
  /**
   * Attempts `pending` or `unknown` and unchanged since `before`: the reconciliation's work. An
   * `unknown` one waits too, so a charge that lands late is found rather than charged again.
   */
  stale(before: string, limit: number): Promise<ChargeAttempt[]>;
}

declare module '../ports.js' {
  interface TransactionContext {
    subscriptions: SubscriptionRepository;
    payments: PaymentRepository;
    /** Null when this installation has no payment provider: nothing can be started. */
    paymentProvider: PaymentProvider | null;
  }
}
