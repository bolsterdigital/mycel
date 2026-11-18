// `subscriptions.charge` (MY-254 PR 2) over the memory adapter: the hourly run charges what is
// due and asks after an attempt whose answer never came only once it waited a quarter of an hour,
// so a charge that reaches the provider late is found rather than made twice. Beside
// `donations-job.test.ts`, in a file of its own for the same reason.

import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_RECONCILE_AFTER_MS,
  Invoker,
  buildRegistry,
  startSubscription,
  useCases,
} from '@mycel/core';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryUnitOfWork,
  TENANT,
  principal,
} from '@mycel/core/testing';
import { RECURRING_JOBS, chargeAllSubscriptions } from './jobs.js';

describe('subscriptions.charge', () => {
  it('charges a gift whose period ended, once, and waits before asking after a lost answer', async () => {
    const clock = new FakeClock();
    const provider = new FakePaymentProvider();
    const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = principal({ capabilities: ['donations:read', 'donations:write'] });
    const tenants = async () => [TENANT];
    const { subscriptionId, paymentId } = await uow.run(admin, (ctx) =>
      startSubscription(ctx, {
        amount: 1000,
        currency: 'EUR',
        description: 'Monthly donation',
        locale: 'nl',
        returnUrl: 'http://localhost:5173/probe/donation/{token}',
        interval: 'month',
      })
    );
    provider.settle(`fake_${paymentId}`, 'paid');
    await invoker.run(useCases.checkDonation, admin, { paymentId, cause: 'webhook' });
    const read = async () =>
      (await invoker.run(useCases.getSubscription, admin, { subscriptionId })).subscription;
    const first = await read();
    // Nothing is due within the first month.
    expect(await chargeAllSubscriptions(uow, tenants)).toBe(0);

    clock.advance(Date.parse(first.paidThrough!) - clock.now().getTime());
    expect(await chargeAllSubscriptions(uow, tenants)).toBe(1);
    const second = await read();
    expect(second).toMatchObject({ periodsPaid: 2, failedAttempts: 0 });
    expect(await chargeAllSubscriptions(uow, tenants)).toBe(0);

    clock.advance(Date.parse(second.paidThrough!) - clock.now().getTime());
    provider.loseNext(true);
    expect(await chargeAllSubscriptions(uow, tenants)).toBe(1);
    // The same hour, or the next run within the quarter: no question, no new charge.
    expect(await chargeAllSubscriptions(uow, tenants)).toBe(0);
    provider.land();
    clock.advance(ATTEMPT_RECONCILE_AFTER_MS + 1000);
    expect(await chargeAllSubscriptions(uow, tenants)).toBe(1);
    expect(provider.charges).toHaveLength(2);
    expect(await read()).toMatchObject({ periodsPaid: 3 });
  });

  it('is planned hourly by the worker', () => {
    expect(RECURRING_JOBS).toContainEqual({ type: 'subscriptions.charge', cadence: 'hourly' });
  });
});
