// A payment provider for a trial installation and the e2e gate (`PAYMENT_PROVIDER=fake`, brief
// MY-252 PR 2): it moves no money and keeps each payment as one JSON file in a directory, so the
// web app (which opens the checkout and shows the fake payment screen), the API and the worker
// (which reconciles) see the same payments, as they see the same mail spool. The screen is a
// page of the site itself (`/<site>/_pay/<ref>`), next to the return page, with a button per
// outcome; choosing one writes the file and sends the visitor back.
//
// Refused in production by the config. Rejected: the in-memory `FakePaymentProvider` of
// `@mycel/core/testing` (one process only), and a separate fake-provider service with its own
// port (a process to start and stop for a page with three buttons).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
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
    const path = this.#path(payment.ref)!;
    // Whole or not at all: a reader in another process never sees half a file.
    writeFileSync(`${path}.tmp`, JSON.stringify(payment));
    renameSync(`${path}.tmp`, path);
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
    };
    this.#write(payment);
    return this.#answer(payment);
  }

  async fetchPayment(ref: string): Promise<ProviderPayment | null> {
    const payment = this.read(ref);
    return payment ? this.#answer(payment) : null;
  }

  #answer(p: FakePayment): ProviderPayment {
    return {
      ref: p.ref,
      outcome: p.outcome,
      raw: p.outcome,
      checkoutUrl: p.outcome === 'open' ? checkoutUrlOf(p.returnUrl, p.ref) : null,
    };
  }
}
