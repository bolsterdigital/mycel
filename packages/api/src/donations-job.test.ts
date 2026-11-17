// `donations.reconcile` (ADR 005 rule 4) over the memory adapter: the payments left open longer
// than a quarter of an hour are asked after, each in its own transaction, so one the provider
// cannot answer about leaves the others settled. In a file of its own beside `jobs.test.ts`,
// which is near its size ceiling.

import { describe, expect, it } from 'vitest';
import { Invoker, RECONCILE_AFTER_MS, buildRegistry, useCases } from '@mycel/core';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryUnitOfWork,
  TENANT,
  principal,
} from '@mycel/core/testing';
import { reconcileAllDonations } from './jobs.js';

describe('donations.reconcile', () => {
  it('settles what the provider knows and leaves an unanswered payment for the next hour', async () => {
    const clock = new FakeClock();
    const provider = new FakePaymentProvider();
    const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = principal({ capabilities: ['donations:read', 'donations:write'] });
    const give = () =>
      invoker.run(useCases.createDonation, admin, {
        amount: 1000,
        currency: 'EUR',
        description: 'Donation',
        locale: 'nl',
        returnUrl: 'http://localhost:5173/probe/donation/{token}',
      });
    const fresh = await give();
    const tenants = async () => [TENANT];
    // Nothing is due within the quarter of an hour.
    expect(await reconcileAllDonations(uow, tenants)).toBe(0);

    clock.advance(RECONCILE_AFTER_MS + 1000);
    const later = await give();
    provider.settle(`fake_${fresh.paymentId}`, 'paid');
    expect(await reconcileAllDonations(uow, tenants)).toBe(1);
    const { donation, ledger } = await invoker.run(useCases.getDonation, admin, {
      paymentId: fresh.paymentId,
    });
    expect(donation.status).toBe('paid');
    expect(ledger.at(-1)).toMatchObject({ from: 'open', to: 'paid', cause: 'reconcile' });
    // The second payment was not due yet.
    expect(
      (await invoker.run(useCases.getDonation, admin, { paymentId: later.paymentId })).ledger
    ).toHaveLength(2);

    clock.advance(RECONCILE_AFTER_MS + 1000);
    provider.failNext();
    expect(await reconcileAllDonations(uow, tenants)).toBe(0);
    provider.settle(`fake_${later.paymentId}`, 'expired');
    expect(await reconcileAllDonations(uow, tenants)).toBe(1);
    expect(
      (await invoker.run(useCases.getDonation, admin, { paymentId: later.paymentId })).donation
        .status
    ).toBe('expired');
  });
});
