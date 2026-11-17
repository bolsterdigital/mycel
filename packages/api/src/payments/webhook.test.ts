// The payment webhook route (MY-252 PR 3): Mollie's form post with `id`, the capability in the
// path, the same 200 for a real and a forged call, and a 503 only when the provider must try again.
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, paymentWebhookToken, useCases } from '@mycel/core';
import { FakePaymentProvider, MemoryUnitOfWork, TENANT, principal } from '@mycel/core/testing';
import { createApp } from '../app.js';

describe('POST /hooks/payments/:token', () => {
  const provider = new FakePaymentProvider();
  const uow = new MemoryUnitOfWork({ paymentProvider: provider });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal({ capabilities: ['donations:read', 'donations:write'] });
  const app = createApp({
    invoker,
    authenticate: async () => null,
    payments: { signer: uow.signer, uow },
  });
  const post = (token: string, body: string) =>
    app.request(`/hooks/payments/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('settles the payment it names and answers alike for a forged call', async () => {
    const { paymentId } = await invoker.run(useCases.createDonation, admin, {
      amount: 1000,
      currency: 'EUR',
      description: 'Gift',
      locale: 'en',
      returnUrl: 'http://localhost:5173/probe/donation/{token}',
    });
    const ref = `fake_${paymentId}`;
    const token = await paymentWebhookToken(uow.signer, TENANT, paymentId);
    expect((await post('forged', `id=${ref}`)).status).toBe(200);
    expect((await post(token, 'id=tr_other')).status).toBe(200);
    provider.settle(ref, 'paid');
    provider.failNext();
    expect((await post(token, `id=${ref}`)).status).toBe(503);
    expect((await post(token, `id=${ref}`)).status).toBe(200);
    const { donation } = await invoker.run(useCases.getDonation, admin, { paymentId });
    expect(donation.status).toBe('paid');
  });

  it('is not there without its dependencies', async () => {
    const bare = createApp({ invoker, authenticate: async () => null });
    expect((await bare.request('/hooks/payments/x', { method: 'POST' })).status).toBe(404);
  });
});
