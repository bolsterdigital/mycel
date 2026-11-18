// The trial installation's payment provider (MY-254 PR 2, brief choice 17): a paid first payment
// leaves a mandate, a charge of it settles at once, fails for an address with `+fail`, and is
// found again by its key, so a repeated call charges once; an unknown mandate is refused.

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DirectoryPaymentProvider } from './fake-payments.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RETURN = 'http://localhost:5173/probe/donation/t';

async function mandateOf(provider: DirectoryPaymentProvider, n: number, email: string) {
  await provider.createCheckout({
    key: ID(n),
    amount: 1000,
    currency: 'EUR',
    description: 'Monthly donation',
    returnUrl: RETURN,
    locale: 'nl',
    sequence: 'first',
    email,
  });
  provider.settle(`fake_${ID(n)}`, 'paid');
  return (await provider.fetchPayment(`fake_${ID(n)}`))!.mandate!;
}

const charge = (provider: DirectoryPaymentProvider, mandateRef: string, key: string, n: number) =>
  provider.chargeMandate({
    key,
    paymentId: ID(n),
    customerRef: 'cst',
    mandateRef,
    amount: 1000,
    currency: 'EUR',
    description: 'Monthly donation',
    locale: 'nl',
  });

describe('DirectoryPaymentProvider', () => {
  it('leaves a mandate for a paid first payment, and none for a one-off gift', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mycel-fake-pay-'));
    const provider = new DirectoryPaymentProvider(dir);
    const mandate = await mandateOf(provider, 1, 'noor@example.org');
    expect(mandate).toMatchObject({ mandateRef: `mdt_fake_${ID(1)}`, valid: true });
    await provider.createCheckout({
      key: ID(2),
      amount: 500,
      currency: 'EUR',
      description: 'Donation',
      returnUrl: RETURN,
      locale: 'nl',
      sequence: 'oneoff',
    });
    provider.settle(`fake_${ID(2)}`, 'paid');
    expect((await provider.fetchPayment(`fake_${ID(2)}`))!.mandate).toBeUndefined();
    // Only the verdict is kept, never the address.
    for (const file of readdirSync(dir))
      expect(readFileSync(join(dir, file), 'utf8')).not.toContain('example.org');
  });

  it('charges once per key, paid by default, failed for +fail, refused without a mandate', async () => {
    const provider = new DirectoryPaymentProvider(mkdtempSync(join(tmpdir(), 'mycel-fake-pay-')));
    const paying = await mandateOf(provider, 1, 'noor@example.org');
    const failing = await mandateOf(provider, 2, 'noor+fail@example.org');
    const key = 'subscription:x:2026-12-18T10:00:00.000Z:1';
    const asked = { key, customerRef: paying.customerRef, mandateRef: paying.mandateRef };
    expect(await provider.findCharge(asked)).toBeNull();
    const ref = `fake_${ID(3)}`;
    expect(await charge(provider, paying.mandateRef, key, 3)).toMatchObject({
      ref,
      outcome: 'paid',
    });
    expect(await charge(provider, paying.mandateRef, key, 4)).toMatchObject({ ref });
    expect(await provider.findCharge(asked)).toMatchObject({ ref, outcome: 'paid' });
    expect(await charge(provider, failing.mandateRef, `${key}x`, 5)).toMatchObject({
      outcome: 'failed',
    });
    // As Mollie answers 422 for a revoked mandate (MY-255): nothing is made.
    expect(await charge(provider, 'mdt_fake_nothing', 'other', 6)).toEqual({
      refused: true,
      raw: 'no_mandate',
    });
    expect(await provider.findCharge({ ...asked, key: 'other' })).toBeNull();
  });
});
