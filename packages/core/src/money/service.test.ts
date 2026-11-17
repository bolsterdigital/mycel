// One-off donations over the memory adapter (ADR 005, brief MY-252 PR 1): opening a checkout,
// the check that walks the state machine with a ledger entry per step, the supporter's event,
// the return token and the capability split. `packages/db/src/money/donation-rule.ts` holds the
// Postgres adapter to the same record.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import type { Capability, Principal } from '../principal.js';
import { SupporterEvent } from '../supporters/events.js';
import { ingest } from '../supporters/service.js';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryLogger,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../testing/index.js';
import { exampleId } from '../util/ids.js';
import { buildRegistry, useCases } from '../use-cases.js';

const TENANT_B = exampleId(0xbbbb);
const RETURN = 'https://probe.example/donation/{token}';

function setup(deps: { provider?: FakePaymentProvider | null } = {}) {
  const clock = new FakeClock();
  const provider = deps.provider === undefined ? new FakePaymentProvider() : deps.provider;
  const log = new MemoryLogger();
  const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider, log });
  const invoker = new Invoker(buildRegistry(), uow);
  const as = (capabilities: Capability[], tenantId = TENANT): Principal =>
    principal({ capabilities, tenantId });
  const admin = as(['donations:read', 'donations:write', 'supporters:read']);
  const give = (
    input: Partial<Parameters<typeof useCases.createDonation.handler>[1]> = {},
    p = admin
  ) =>
    invoker.run(useCases.createDonation, p, {
      amount: 2500,
      currency: 'EUR',
      description: 'Donation to Probe',
      locale: 'nl',
      returnUrl: RETURN,
      ...input,
    });
  const check = (
    paymentId: string,
    cause: 'return' | 'webhook' | 'reconcile' | 'operator' = 'webhook'
  ) => invoker.run(useCases.checkDonation, admin, { paymentId, cause });
  const read = (paymentId: string) => invoker.run(useCases.getDonation, admin, { paymentId });
  const supporter = async (email: string) => {
    await uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `money-test:${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: `test:${email}`,
          props: { list: 'news' },
        })
      )
    );
    return invoker.run(useCases.getSupporter, admin, { email });
  };
  const eventsOf = (supporterId: string) =>
    uow.run(admin, async (ctx) =>
      (await ctx.supporters.eventsFor(supporterId)).filter((e) => e.type.startsWith('donation.'))
    );
  return { clock, provider, log, uow, invoker, as, admin, give, check, read, supporter, eventsOf };
}

describe('a one-off donation (ADR 005)', () => {
  it('opens a checkout and records the payment as open, with two ledger entries', async () => {
    const { give, read, provider } = setup();
    const started = await give();
    expect(started.status).toBe('open');
    expect(started.checkoutUrl).toBe(`https://pay.example/checkout/fake_${started.paymentId}`);
    // The provider is told where to send the donor: our URL with the token in place.
    expect(provider!.requests[0]).toMatchObject({
      key: started.paymentId,
      amount: 2500,
      currency: 'EUR',
      returnUrl: `https://probe.example/donation/${encodeURIComponent(started.token)}`,
    });
    const { donation, ledger } = await read(started.paymentId);
    expect(donation).toMatchObject({
      kind: 'donation',
      status: 'open',
      amount: 2500,
      currency: 'EUR',
      provider: 'fake',
      providerRef: `fake_${started.paymentId}`,
      supporterId: null,
      paidAt: null,
    });
    expect(ledger.map((e) => [e.from, e.to, e.cause])).toEqual([
      [null, 'created', 'checkout'],
      ['created', 'open', 'checkout'],
    ]);
    expect(ledger.every((e) => e.amount === 2500 && e.currency === 'EUR')).toBe(true);
  });

  it('records paid once, however often it is checked', async () => {
    const { give, check, read, provider, clock } = setup();
    const { paymentId } = await give();
    expect(await check(paymentId)).toMatchObject({ status: 'open', paidAt: null });
    provider!.settle(`fake_${paymentId}`, 'paid');
    clock.advance(60_000);
    const paid = await check(paymentId);
    expect(paid).toEqual({
      status: 'paid',
      amount: 2500,
      currency: 'EUR',
      paidAt: clock.now().toISOString(),
    });
    clock.advance(60_000);
    expect(await check(paymentId, 'reconcile')).toEqual(paid);
    const { donation, ledger } = await read(paymentId);
    expect(donation.checkoutUrl).toBeNull();
    expect(ledger.map((e) => [e.from, e.to, e.cause])).toEqual([
      [null, 'created', 'checkout'],
      ['created', 'open', 'checkout'],
      ['open', 'paid', 'webhook'],
    ]);
  });

  it('keeps the provider’s own word beside the status: a donor who backs out failed', async () => {
    const { give, check, read, provider } = setup();
    const { paymentId } = await give();
    provider!.settle(`fake_${paymentId}`, 'failed', 'canceled');
    expect((await check(paymentId, 'return')).status).toBe('failed');
    const { donation, ledger } = await read(paymentId);
    expect(donation.providerStatus).toBe('canceled');
    expect(ledger.at(-1)).toMatchObject({ from: 'open', to: 'failed', cause: 'return' });
    // Final: a later report changes nothing, and the provider is not even asked.
    provider!.settle(`fake_${paymentId}`, 'paid');
    provider!.failNext();
    expect((await check(paymentId)).status).toBe('failed');
  });

  it('walks the steps a missed report skipped, each with its own entry', async () => {
    const { give, check, read, provider } = setup();
    const { paymentId } = await give();
    provider!.settle(`fake_${paymentId}`, 'refunded');
    expect((await check(paymentId, 'reconcile')).status).toBe('refunded');
    const { donation, ledger } = await read(paymentId);
    expect(donation.paidAt).not.toBeNull();
    expect(ledger.slice(2).map((e) => [e.from, e.to, e.cause])).toEqual([
      ['open', 'paid', 'reconcile'],
      ['paid', 'refunded', 'reconcile'],
    ]);
  });

  it('changes nothing on a report the state machine cannot reach, and says so in the log', async () => {
    const { give, check, read, provider, log } = setup();
    const { paymentId } = await give();
    provider!.settle(`fake_${paymentId}`, 'paid');
    await check(paymentId);
    provider!.settle(`fake_${paymentId}`, 'open');
    expect((await check(paymentId)).status).toBe('paid');
    expect((await read(paymentId)).ledger).toHaveLength(3);
    expect(log.lines.some((l) => l.message === 'donation.check.unreachable')).toBe(true);
  });

  it('records a provider that settles at once in the same call', async () => {
    const provider = new FakePaymentProvider();
    provider.opensAs = 'paid';
    const { give, read } = setup({ provider });
    const started = await give();
    expect(started).toMatchObject({ status: 'paid', checkoutUrl: null });
    expect((await read(started.paymentId)).ledger.map((e) => e.to)).toEqual([
      'created',
      'open',
      'paid',
    ]);
  });

  it('notes a settled payment in the supporter’s log, once, as a reference', async () => {
    const { give, check, provider, supporter, eventsOf, read } = setup();
    const noor = await supporter('noor@example.org');
    const { paymentId } = await give({ supporterId: noor.id });
    expect(await eventsOf(noor.id)).toEqual([]);
    provider!.settle(`fake_${paymentId}`, 'paid');
    await check(paymentId);
    await check(paymentId);
    const events = await eventsOf(noor.id);
    expect(events.map((e) => [e.type, e.source_ref, e.props])).toEqual([
      [
        'donation.payment.succeeded',
        `payment:${paymentId}`,
        { payment_id: paymentId, amount: 2500, currency: 'EUR' },
      ],
    ]);
    expect((await read(paymentId)).donation.supporterId).toBe(noor.id);

    const second = await give({ supporterId: noor.id, amount: 1000 });
    provider!.settle(`fake_${second.paymentId}`, 'expired');
    await check(second.paymentId);
    expect((await eventsOf(noor.id)).map((e) => e.type)).toEqual([
      'donation.payment.succeeded',
      'donation.payment.failed',
    ]);
  });

  it('settles without an event once the supporter is erased, and forgets who gave', async () => {
    const { give, check, provider, supporter, read, uow, admin } = setup();
    const gone = await supporter('gone@example.org');
    const { paymentId } = await give({ supporterId: gone.id });
    await uow.run(admin, (ctx) => ctx.erasures.register(gone.id, gone.email));
    provider!.settle(`fake_${paymentId}`, 'paid');
    expect((await check(paymentId)).status).toBe('paid');
    const events = await uow.run(admin, (ctx) => ctx.supporters.eventsFor(gone.id));
    expect(events.filter((e) => e.type.startsWith('donation.'))).toEqual([]);
    await uow.run(admin, (ctx) => ctx.erasures.apply());
    const { donation, ledger } = await read(paymentId);
    expect(donation).toMatchObject({ status: 'paid', amount: 2500, supporterId: null });
    expect(ledger).toHaveLength(3);
    await expectCode(give({ supporterId: gone.id }), 'not_found');
  });

  it('answers the donor’s token with status and amount only', async () => {
    const { give, invoker, as, provider } = setup();
    const { paymentId, token } = await give();
    provider!.settle(`fake_${paymentId}`, 'paid');
    const visitor = as(['donations:write']);
    const outcome = await invoker.run(useCases.checkDonation, visitor, { token, cause: 'return' });
    expect(Object.keys(outcome).sort()).toEqual(['amount', 'currency', 'paidAt', 'status']);
    expect(outcome.status).toBe('paid');
    await expectCode(
      invoker.run(useCases.checkDonation, visitor, { token: `${token}x`, cause: 'return' }),
      'not_found'
    );
    await expectCode(
      invoker.run(useCases.checkDonation, visitor, { token: 'other:thing~gniht:rehto' }),
      'not_found'
    );
    await expectCode(invoker.run(useCases.checkDonation, visitor, {}), 'invalid_input');
    await expectCode(
      invoker.run(useCases.checkDonation, visitor, { token, paymentId }),
      'invalid_input'
    );
  });

  it('refuses what it cannot charge or return from', async () => {
    const { give } = setup();
    await expectCode(give({ amount: 99 }), 'invalid_input');
    await expectCode(give({ amount: 5_000_001 }), 'invalid_input');
    await expectCode(give({ amount: 12.5 }), 'invalid_input');
    await expectCode(give({ currency: 'USD' }), 'invalid_input');
    await expectCode(give({ returnUrl: 'https://probe.example/thanks' }), 'invalid_input');
    await expectCode(give({ supporterId: exampleId(0x404) }), 'not_found');
  });

  it('stores nothing when the provider does not open a checkout', async () => {
    const { give, provider, invoker, admin, log } = setup();
    provider!.failNext();
    await expectCode(give(), 'conflict');
    expect((await invoker.run(useCases.listDonations, admin, {})).donations).toEqual([]);
    // The log names the adapter, never the provider's message (it quotes the return URL).
    const line = log.lines.find((l) => l.message === 'donation.create.provider-failed');
    expect(line?.fields).toEqual({ provider: 'fake' });
  });

  it('leaves the payment as it is when the provider does not answer a check', async () => {
    const { give, check, provider, read } = setup();
    const { paymentId } = await give();
    provider!.settle(`fake_${paymentId}`, 'paid');
    provider!.failNext();
    await expectCode(check(paymentId), 'conflict');
    expect((await read(paymentId)).donation.status).toBe('open');
    provider!.forget(`fake_${paymentId}`);
    expect((await check(paymentId)).status).toBe('open');
  });

  it('needs a provider, the entitlement and the capability', async () => {
    const none = setup({ provider: null });
    await expectCode(none.give(), 'conflict');

    const { give, as, invoker, admin } = setup();
    const { paymentId } = await give();
    await expectCode(give({}, as(['donations:read'])), 'forbidden');
    await expectCode(
      invoker.run(useCases.getDonation, as(['donations:write']), { paymentId }),
      'forbidden'
    );
    await expectCode(invoker.run(useCases.listDonations, as(['supporters:read']), {}), 'forbidden');
    const off = principal({
      capabilities: ['donations:write'],
      entitlements: { 'donations.enabled': false },
    });
    await expectCode(give({}, off), 'limit_exceeded');
  });

  it('lists newest first, by status and by supporter, and keeps tenants apart', async () => {
    const { give, check, provider, supporter, invoker, admin, as, clock } = setup();
    const noor = await supporter('noor@example.org');
    const first = await give({ amount: 1000 });
    clock.advance(1000);
    const second = await give({ amount: 2000, supporterId: noor.id });
    clock.advance(1000);
    const third = await give({ amount: 3000 });
    provider!.settle(`fake_${second.paymentId}`, 'paid');
    await check(second.paymentId);
    const list = (input = {}) => invoker.run(useCases.listDonations, admin, input);
    expect((await list()).donations.map((d) => d.amount)).toEqual([3000, 2000, 1000]);
    expect((await list({ status: 'paid' })).donations.map((d) => d.id)).toEqual([second.paymentId]);
    expect((await list({ supporterId: noor.id })).donations.map((d) => d.amount)).toEqual([2000]);
    const page = await list({ limit: 2 });
    expect(page.donations.map((d) => d.id)).toEqual([third.paymentId, second.paymentId]);
    expect(page.nextOffset).toBe(2);
    expect((await list({ limit: 2, offset: 2 })).donations.map((d) => d.id)).toEqual([
      first.paymentId,
    ]);

    const other = as(['donations:read', 'donations:write'], TENANT_B);
    expect((await invoker.run(useCases.listDonations, other, {})).donations).toEqual([]);
    await expectCode(
      invoker.run(useCases.getDonation, other, { paymentId: first.paymentId }),
      'not_found'
    );
    await expectCode(
      invoker.run(useCases.checkDonation, other, { paymentId: first.paymentId }),
      'not_found'
    );
  });
});
