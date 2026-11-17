// The provider's webhook and the return host (brief MY-252 PR 3) over the memory adapter: a
// webhook is a signed capability for one payment that only makes `checkPayment` ask the provider,
// and the donor is only ever sent back to a host of the site that took the gift.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../testing/index.js';
import { exampleId } from '../util/ids.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { paymentWebhookToken, receivePaymentWebhook } from './webhook.js';

const RETURN = 'http://localhost:5173/probe/donation/{token}';

function setup() {
  const clock = new FakeClock();
  const provider = new FakePaymentProvider();
  const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal({ capabilities: ['donations:read', 'donations:write'] });
  const give = (returnUrl = RETURN) =>
    invoker.run(useCases.createDonation, admin, {
      amount: 2500,
      currency: 'EUR',
      description: 'Gift to Probe',
      locale: 'nl',
      returnUrl,
    });
  const read = (paymentId: string) => invoker.run(useCases.getDonation, admin, { paymentId });
  const hook = (token: string, ref: string) =>
    receivePaymentWebhook({ signer: uow.signer, uow }, token, ref);
  return { clock, provider, uow, invoker, admin, give, read, hook };
}

describe('receivePaymentWebhook', () => {
  it('checks the payment its capability names, with cause webhook', async () => {
    const { provider, uow, give, read, hook } = setup();
    const { paymentId } = await give();
    provider.settle(`fake_${paymentId}`, 'paid');
    const token = await paymentWebhookToken(uow.signer, TENANT, paymentId);
    expect(await hook(token, `fake_${paymentId}`)).toBe('checked');
    const { donation, ledger } = await read(paymentId);
    expect(donation.status).toBe('paid');
    expect(ledger.at(-1)).toMatchObject({ to: 'paid', cause: 'webhook' });
    // A second call finds nothing new and writes nothing.
    expect(await hook(token, `fake_${paymentId}`)).toBe('checked');
    expect((await read(paymentId)).ledger).toHaveLength(ledger.length);
  });

  it('ignores a forged capability, another reference and another tenant', async () => {
    const { provider, uow, give, read, hook } = setup();
    const { paymentId } = await give();
    provider.settle(`fake_${paymentId}`, 'paid');
    const ref = `fake_${paymentId}`;
    expect(await hook('payment-webhook-v1~forged', ref)).toBe('ignored');
    expect(await hook(await uow.signer.sign('{"domain":"other"}'), ref)).toBe('ignored');
    const token = await paymentWebhookToken(uow.signer, TENANT, paymentId);
    expect(await hook(token, 'fake_someone-else')).toBe('ignored');
    expect(await hook(token, '')).toBe('ignored');
    const elsewhere = await paymentWebhookToken(uow.signer, exampleId(0xbbbb), paymentId);
    expect(await hook(elsewhere, ref)).toBe('ignored');
    expect((await read(paymentId)).donation.status).toBe('open');
  });

  it('asks for a retry when the provider does not answer', async () => {
    const { provider, uow, give, read, hook } = setup();
    const { paymentId } = await give();
    provider.settle(`fake_${paymentId}`, 'paid');
    provider.failNext();
    const token = await paymentWebhookToken(uow.signer, TENANT, paymentId);
    expect(await hook(token, `fake_${paymentId}`)).toBe('retry');
    expect((await read(paymentId)).donation.status).toBe('open');
  });

  it('stops looking after thirty calls a minute for one payment', async () => {
    const { uow, give, hook } = setup();
    const { paymentId } = await give();
    const token = await paymentWebhookToken(uow.signer, TENANT, paymentId);
    const results = [];
    for (let i = 0; i < 31; i++) results.push(await hook(token, `fake_${paymentId}`));
    expect(results.slice(0, 30).every((r) => r === 'checked')).toBe(true);
    expect(results[30]).toBe('ignored');
  });
});

describe('the return host', () => {
  it('sends the donor back only to a host of this site', async () => {
    const { uow, admin, give } = setup();
    await uow.run(admin, async (ctx) => {
      const at = new Date();
      const row = { verificationToken: 'x', createdAt: at, kind: 'custom' as const };
      await ctx.hostnames.insert({ ...row, hostname: 'giving.example', verifiedAt: at });
      await ctx.hostnames.insert({ ...row, hostname: 'pending.example', verifiedAt: null });
    });
    expect((await give('http://giving.example:5173/donation/{token}')).status).toBe('open');
    for (const url of [
      'http://pending.example:5173/donation/{token}',
      'http://elsewhere.example:5173/donation/{token}',
      'https://localhost:5173/probe/donation/{token}',
      'http://giving.example/donation/{token}',
      'http://user@localhost:5173/probe/donation/{token}',
    ])
      await expectCode(give(url), 'invalid_input');
  });
});
