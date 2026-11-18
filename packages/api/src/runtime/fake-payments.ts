// A payment provider for a trial installation and the e2e gate (`PAYMENT_PROVIDER=fake`, brief
// MY-252 PR 2): it moves no money and keeps each payment as one JSON file in a directory, so the
// web app (which opens the checkout and shows the fake payment screen), the API and the worker
// (which reconciles) see the same payments, as they see the same mail spool. The screen is a
// page of the site itself (`/<site>/_pay/<ref>`), next to the return page, with a button per
// outcome; choosing one writes the file and sends the visitor back.
//
// Monthly and yearly giving (MY-254 PR 2, brief choice 17): a first payment paid on the screen
// leaves a mandate, and a charge of it is settled at once, `paid`, or `failed` when the donor's
// address has `+fail` in it, so the dunning shows without buttons. The address itself is not
// kept, only that verdict. A charge is found again by its key through an index file per key.
//
// Refused in production by the config. Rejected: the in-memory `FakePaymentProvider` of
// `@mycel/core/testing` (one process only), and a separate fake-provider service with its own
// port (a process to start and stop for a page with three buttons).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ChargeRequest,
  FindChargeRequest,
  CheckoutRequest,
  PaymentProvider,
  ProviderOutcome,
  ProviderPayment,
} from '@mycel/core';

/** What the fake screen shows and needs to send the visitor back. */
export interface FakePayment {
  ref: string;
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  outcome: ProviderOutcome;
  /** A subscription's first payment: paid, it leaves a mandate. */
  first?: boolean;
  /** Charges of that mandate fail (`+fail` in the donor's address). */
  failCharges?: boolean;
}

/** A reference this provider hands out: our payment id behind a fixed prefix, nothing else. */
const REF = /^fake_[0-9a-f-]{36}$/;

/** The outcomes the screen offers the visitor. */
export const FAKE_CHOICES = ['paid', 'failed', 'expired'] as const;
export type FakeChoice = (typeof FAKE_CHOICES)[number];

/**
 * The page of the screen sits beside the return page: the return URL is
 * `<site>/donation/<token>`, the screen `<site>/_pay/<ref>`.
 */
function checkoutUrlOf(returnUrl: string, ref: string): string {
  const url = new URL(returnUrl);
  const at = url.pathname.lastIndexOf('/donation/');
  const base = at >= 0 ? url.pathname.slice(0, at) : '';
  return `${url.origin}${base}/_pay/${ref}`;
}

export class DirectoryPaymentProvider implements PaymentProvider {
  readonly id = 'fake';

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  #path(ref: string): string | null {
    return REF.test(ref) ? join(this.dir, `${ref}.json`) : null;
  }

  /** The payment as stored, or null for a reference this provider did not hand out. */
  read(ref: string): FakePayment | null {
    const path = this.#path(ref);
    if (!path) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as FakePayment;
    } catch {
      return null;
    }
  }

  #write(payment: FakePayment): void {
    this.#writeFile(this.#path(payment.ref)!, payment);
  }

  /** Whole or not at all: a reader in another process never sees half a file. */
  #writeFile(path: string, value: unknown): void {
    writeFileSync(`${path}.tmp`, JSON.stringify(value));
    renameSync(`${path}.tmp`, path);
  }

  /** Where the charge made with `key` is noted: a key holds colons and times, so its hash. */
  #chargePath(key: string): string {
    return join(this.dir, `charge_${createHash('sha256').update(key).digest('hex')}.json`);
  }

  /** The visitor's choice on the screen; only an open payment moves. Null when unknown. */
  settle(ref: string, choice: FakeChoice): FakePayment | null {
    const payment = this.read(ref);
    if (!payment) return null;
    if (payment.outcome !== 'open') return payment;
    const settled = { ...payment, outcome: choice };
    this.#write(settled);
    return settled;
  }

  async createCheckout(request: CheckoutRequest): Promise<ProviderPayment> {
    const ref = `fake_${request.key}`;
    const known = this.read(ref);
    if (known) return this.#answer(known);
    const payment: FakePayment = {
      ref,
      amount: request.amount,
      currency: request.currency,
      description: request.description,
      returnUrl: request.returnUrl,
      outcome: 'open',
      ...(request.sequence === 'first'
        ? { first: true, failCharges: (request.email ?? '').includes('+fail') }
        : {}),
    };
    this.#write(payment);
    return this.#answer(payment);
  }

  async fetchPayment(ref: string): Promise<ProviderPayment | null> {
    const payment = this.read(ref);
    return payment ? this.#answer(payment) : null;
  }

  async chargeMandate(request: ChargeRequest): Promise<ProviderPayment> {
    const known = await this.findCharge(request);
    if (known) return known;
    // The mandate is `mdt_<ref of the first payment>`; nothing else charges.
    const first = this.read(request.mandateRef.replace(/^mdt_/, ''));
    if (!first?.first || first.outcome !== 'paid')
      throw new Error('fake provider knows no such mandate');
    const payment: FakePayment = {
      ref: `fake_${request.paymentId}`,
      amount: request.amount,
      currency: request.currency,
      description: request.description,
      returnUrl: first.returnUrl,
      outcome: first.failCharges ? 'failed' : 'paid',
    };
    if (!this.#path(payment.ref)) throw new Error('fake provider refuses that payment id');
    this.#write(payment);
    this.#writeFile(this.#chargePath(request.key), { ref: payment.ref });
    return this.#answer(payment);
  }

  async findCharge({ key }: FindChargeRequest): Promise<ProviderPayment | null> {
    let ref: string;
    try {
      ref = (JSON.parse(readFileSync(this.#chargePath(key), 'utf8')) as { ref: string }).ref;
    } catch {
      return null;
    }
    const payment = this.read(ref);
    return payment ? this.#answer(payment) : null;
  }

  #answer(p: FakePayment): ProviderPayment {
    return {
      ref: p.ref,
      outcome: p.outcome,
      raw: p.outcome,
      checkoutUrl: p.outcome === 'open' ? checkoutUrlOf(p.returnUrl, p.ref) : null,
      ...(p.first && p.outcome === 'paid'
        ? {
            mandate: {
              customerRef: `cst_${p.ref}`,
              mandateRef: `mdt_${p.ref}`,
              method: 'directdebit',
              valid: true,
            },
          }
        : {}),
    };
  }
}
