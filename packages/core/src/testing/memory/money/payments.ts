// Payments and their ledger in memory (ADR 005), with the same order and filters as 0072. The
// fake provider is the other side of a payment for tests and for a trial installation: a test
// settles a payment by its reference and the next `donation.check` finds it.

import type { LedgerEntry, Payment } from '../../../money/model.js';
import type {
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
    list: async ({ status, supporterId }, offset, limit) =>
      structuredClone(
        [...rows.values()]
          .filter(
            (p) =>
              (!status || p.status === status) && (!supporterId || p.supporterId === supporterId)
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(offset, offset + limit)
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
  readonly #payments = new Map<string, ProviderPayment>();
  #failing = false;
  /** What a new checkout starts as; `paid` plays a provider that settles at once. */
  opensAs: ProviderOutcome = 'open';

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
    return { ...payment };
  }

  async fetchPayment(ref: string): Promise<ProviderPayment | null> {
    if (this.#failing) {
      this.#failing = false;
      throw new Error('fake provider outage');
    }
    const payment = this.#payments.get(ref);
    return payment ? { ...payment } : null;
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
}
