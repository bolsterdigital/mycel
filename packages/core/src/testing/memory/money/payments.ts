// Payments and their ledger in memory (ADR 005), with the same order and filters as 0072. The
// fake provider is the other side of a payment for tests and for a trial installation: a test
// settles a payment by its reference and the next `donation.check` finds it. A paid first payment
// leaves a mandate, and a charge of it succeeds unless the test says otherwise (`chargesAs`,
// `failNext`, `loseNext` for a call that charged but never answered).

import type { LedgerEntry, Payment } from '../../../money/model.js';
import type {
  ChargeRequest,
  FindChargeRequest,
  CheckoutRequest,
  PaymentProvider,
  PaymentRepository,
  ProviderOutcome,
  ProviderPayment,
} from '../../../money/ports.js';
import type { TenantStore } from '../store.js';

export function memoryPayments(s: TenantStore): PaymentRepository {
  const rows = s.payments;
  return {
    async insert(payment) {
      rows.set(payment.id, structuredClone(payment));
    },
    get: async (id) => structuredClone(rows.get(id) ?? null),
    lock: async (id) => structuredClone(rows.get(id) ?? null),
    async save(payment) {
      if (rows.has(payment.id)) rows.set(payment.id, structuredClone(payment));
    },
    list: async ({ status, supporterId, subscriptionId }, offset, limit) =>
      structuredClone(
        [...rows.values()]
          .filter(
            (p) =>
              (!status || p.status === status) &&
              (!supporterId || p.supporterId === supporterId) &&
              (!subscriptionId || p.subscriptionId === subscriptionId)
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(offset, offset + limit)
      ),
    async raised(campaignIds, currency) {
      const sums = new Map<string, { amount: number; gifts: number }>();
      for (const p of rows.values()) {
        if (p.status !== 'paid' || p.currency !== currency || !p.campaignId) continue;
        if (!campaignIds.includes(p.campaignId)) continue;
        const sum = sums.get(p.campaignId) ?? { amount: 0, gifts: 0 };
        sums.set(p.campaignId, { amount: sum.amount + p.amount, gifts: sum.gifts + 1 });
      }
      return sums;
    },
    due: async (before, limit) =>
      structuredClone(
        [...rows.values()]
          .filter((p) => (p.status === 'created' || p.status === 'open') && p.updatedAt < before)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
          .slice(0, limit)
      ),
    async appendLedger(entry) {
      s.ledgerEntries.push(structuredClone(entry));
    },
    // The order of appending, as `seq` in 0072: not `at` or the id, which tie within one walk.
    ledger: async (paymentId) =>
      structuredClone(s.ledgerEntries.filter((e: LedgerEntry) => e.paymentId === paymentId)),
  };
}

/**
 * A payment provider that settles nothing by itself: `settle` plays the donor (or the bank) and
 * `failNext` an outage. One checkout per key, as a real provider keeps its idempotency key.
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly id = 'fake';
  readonly requests: CheckoutRequest[] = [];
  readonly charges: ChargeRequest[] = [];
  readonly #payments = new Map<string, ProviderPayment>();
  /** Charges by their key, as a provider keeps its idempotency key. */
  readonly #charges = new Map<string, string>();
  /** First payments, whose `paid` leaves a mandate. */
  readonly #firsts = new Set<string>();
  #failing = false;
  #losing = false;
  /** What a new checkout starts as; `paid` plays a provider that settles at once. */
  opensAs: ProviderOutcome = 'open';
  /** What a new charge starts as: settled at once, or `open` until `settle`. */
  chargesAs: ProviderOutcome = 'paid';

  async createCheckout(request: CheckoutRequest): Promise<ProviderPayment> {
    if (this.#failing) {
      this.#failing = false;
      throw new Error(`fake provider outage for ${request.returnUrl}`);
    }
    const ref = `fake_${request.key}`;
    const known = this.#payments.get(ref);
    if (known) return { ...known };
    this.requests.push(request);
    const payment: ProviderPayment = {
      ref,
      outcome: this.opensAs,
      raw: this.opensAs,
      checkoutUrl: this.opensAs === 'open' ? `https://pay.example/checkout/${ref}` : null,
    };
    this.#payments.set(ref, payment);
    if (request.sequence === 'first') this.#firsts.add(ref);
    return this.#answer(ref);
  }

  async fetchPayment(ref: string): Promise<ProviderPayment | null> {
    if (this.#failing) {
      this.#failing = false;
      throw new Error('fake provider outage');
    }
    return this.#payments.has(ref) ? this.#answer(ref) : null;
  }

  async chargeMandate(request: ChargeRequest): Promise<ProviderPayment> {
    if (this.#failing) {
      this.#failing = false;
      throw new Error('fake provider outage');
    }
    const known = this.#charges.get(request.key);
    if (known) return this.#answer(known);
    this.charges.push(request);
    const ref = `fake_${request.paymentId}`;
    this.#payments.set(ref, {
      ref,
      outcome: this.chargesAs,
      raw: this.chargesAs,
      checkoutUrl: null,
    });
    this.#charges.set(request.key, ref);
    if (this.#losing) {
      this.#losing = false;
      throw new Error('fake provider timeout after charging');
    }
    return this.#answer(ref);
  }

  async findCharge({ key }: FindChargeRequest): Promise<ProviderPayment | null> {
    if (this.#failing) {
      this.#failing = false;
      throw new Error('fake provider outage');
    }
    const ref = this.#charges.get(key);
    return ref ? this.#answer(ref) : null;
  }

  /** The payment, with the mandate a paid first payment leaves. */
  #answer(ref: string): ProviderPayment {
    const payment = { ...this.#payments.get(ref)! };
    if (this.#firsts.has(ref) && payment.outcome === 'paid')
      payment.mandate = {
        customerRef: `cst_${ref}`,
        mandateRef: `mdt_${ref}`,
        method: 'directdebit',
        valid: true,
      };
    return payment;
  }

  /** The provider's side moves; `raw` is its own word when that differs from ours. */
  settle(ref: string, outcome: ProviderOutcome, raw: string = outcome): void {
    const payment = this.#payments.get(ref);
    if (!payment) throw new Error(`fake provider has no payment ${ref}`);
    this.#payments.set(ref, {
      ...payment,
      outcome,
      raw,
      checkoutUrl: outcome === 'open' ? payment.checkoutUrl : null,
    });
  }

  /** The provider forgets a payment, as after its own retention. */
  forget(ref: string): void {
    this.#payments.delete(ref);
  }

  failNext(): void {
    this.#failing = true;
  }

  /** The next charge goes through at the provider, but its answer never arrives. */
  loseNext(): void {
    this.#losing = true;
  }
}
