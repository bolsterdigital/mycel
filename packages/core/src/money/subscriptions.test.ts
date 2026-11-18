// Monthly and yearly giving over the memory adapter (ADR 005 rules 1-7, ADR 019 rule 6, brief
// MY-254 PR 1): the first payment that leaves a mandate, the charge run with its intent row, the
// dunning policy, a charge whose answer never came, a chargeback, cancelling, and the capability
// split. `packages/db/src/money/subscription-rule.ts` holds the Postgres adapter to the same record.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Capability, type Principal } from '../principal.js';
import { SupporterEvent } from '../supporters/events.js';
import { ingest } from '../supporters/service.js';
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
import type { PaymentProvider } from './ports.js';
import { Subscription } from './subscription-model.js';
import {
  ATTEMPT_RECONCILE_AFTER_MS,
  chargeSubscription,
  dueSubscriptions,
  reconcileChargeAttempt,
  staleChargeAttempts,
  startSubscription,
  type SubscriptionStart,
} from './subscriptions.js';

const DAY = 24 * 60 * 60 * 1000;
const CAMPAIGN = exampleId(0xc);

function setup(provider: PaymentProvider = new FakePaymentProvider()) {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
  const invoker = new Invoker(buildRegistry(), uow);
  const as = (capabilities: Capability[], tenantId = TENANT): Principal =>
    principal({ capabilities, tenantId });
  const admin = as(['donations:read', 'donations:write', 'supporters:read']);
  const run = systemPrincipal(TENANT, 'subscriptions.charge');
  const start = (input: Partial<SubscriptionStart> = {}) =>
    uow.run(admin, (ctx) =>
      startSubscription(ctx, {
        amount: 1000,
        currency: 'EUR',
        description: 'Monthly gift to Probe',
        locale: 'nl',
        returnUrl: 'http://localhost:5173/probe/donation/{token}',
        interval: 'month',
        ...input,
      })
    );
  const read = (subscriptionId: string, p = admin) =>
    invoker.run(useCases.getSubscription, p, { subscriptionId });
  const steps = async (id: string) =>
    (await read(id)).ledger.map((e) => `${e.from ?? '-'}>${e.to}:${e.step}:${e.cause}`);
  const check = (paymentId: string) =>
    invoker.run(useCases.checkDonation, admin, { paymentId, cause: 'webhook' });
  const charge = (id: string) => chargeSubscription(uow, run, id);
  const due = () => uow.run(run, (ctx) => dueSubscriptions(ctx));
  const supporter = async (email: string) => {
    await uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `subscription-test:${email}`,
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
  const events = (supporterId: string) =>
    uow.run(admin, async (ctx) =>
      (await ctx.supporters.eventsFor(supporterId))
        .filter((e) => e.type.startsWith('donation.'))
        .map((e) => [e.type, e.props['reason']].filter(Boolean).join(' '))
    );
  /** A monthly gift whose first payment is paid, with the clock where it is due next. */
  const active = async (input: Partial<SubscriptionStart> = {}) => {
    const started = await start(input);
    (provider as FakePaymentProvider).settle(`fake_${started.paymentId}`, 'paid');
    await check(started.paymentId);
    const { subscription } = await read(started.subscriptionId);
    return { ...started, subscription };
  };
  const to = (at: string) => {
    clock.current = new Date(at);
  };
  return {
    clock,
    provider: provider as FakePaymentProvider,
    uow,
    invoker,
    as,
    admin,
    run,
    start,
    read,
    steps,
    check,
    charge,
    due,
    supporter,
    events,
    active,
    to,
  };
}

describe('a monthly gift (ADR 005)', () => {
  it('starts pending with a first payment that asks for a mandate, and is active once paid', async () => {
    const { start, read, steps, check, provider, supporter, events, clock } = setup();
    const noor = await supporter('noor@example.org');
    const started = await start({ supporterId: noor.id, campaignId: CAMPAIGN });
    expect(provider.requests.map((r) => r.sequence)).toEqual(['first']);
    expect((await read(started.subscriptionId)).subscription.status).toBe('pending');

    provider.settle(`fake_${started.paymentId}`, 'paid');
    await check(started.paymentId);
    const { subscription, payments } = await read(started.subscriptionId);
    const paidAt = clock.now().toISOString();
    expect(subscription).toMatchObject({
      status: 'active',
      supporterId: noor.id,
      startedAt: paidAt,
      periodsPaid: 1,
      paidThrough: '2026-11-21T12:00:00.000Z',
      nextChargeAt: '2026-11-21T12:00:00.000Z',
      failedAttempts: 0,
    });
    expect(subscription.mandateId).not.toBeNull();
    expect(payments.map((p) => [p.sequence, p.status, p.campaignId])).toEqual([
      ['first', 'paid', CAMPAIGN],
    ]);
    expect(await steps(started.subscriptionId)).toEqual([
      '->pending:started:checkout',
      'pending>active:activated:webhook',
    ]);
    expect(await events(noor.id)).toEqual([
      'donation.payment.succeeded',
      'donation.subscription.started',
    ]);
  });

  it('charges once when the period ends and counts the next period from the start', async () => {
    const { active, charge, due, read, steps, provider, to } = setup();
    const { subscriptionId, subscription } = await active({ campaignId: CAMPAIGN });
    expect(await due()).toEqual([]);
    expect(await charge(subscriptionId)).toBe('not-due');

    to(subscription.paidThrough!);
    expect(await due()).toEqual([subscriptionId]);
    expect(await charge(subscriptionId)).toBe('charged');
    expect(await charge(subscriptionId)).toBe('not-due');
    expect(provider.charges.map((c) => c.key)).toEqual([
      `subscription:${subscriptionId}:2026-11-21T12:00:00.000Z:1`,
    ]);
    const after = await read(subscriptionId);
    expect(after.subscription).toMatchObject({
      periodsPaid: 2,
      paidThrough: '2026-12-21T12:00:00.000Z',
      nextChargeAt: '2026-12-21T12:00:00.000Z',
    });
    expect(after.payments.map((p) => [p.sequence, p.status, p.campaignId])).toEqual([
      ['recurring', 'paid', CAMPAIGN],
      ['first', 'paid', CAMPAIGN],
    ]);
    expect((await steps(subscriptionId)).at(-1)).toBe('active>active:renewed:charge');
  });

  it('tries a failed charge again on day 3 and 7, then ends it and tells the giver', async () => {
    const { active, charge, read, provider, to, clock, supporter, events } = setup();
    const noor = await supporter('fails@example.org');
    const { subscriptionId, subscription } = await active({ supporterId: noor.id });
    provider.chargesAs = 'failed';
    const dueAt = subscription.paidThrough!;
    to(dueAt);
    expect(await charge(subscriptionId)).toBe('charged');
    expect((await read(subscriptionId)).subscription).toMatchObject({
      status: 'active',
      failedAttempts: 1,
      paidThrough: dueAt,
      nextChargeAt: '2026-11-24T12:00:00.000Z',
    });
    expect(await charge(subscriptionId)).toBe('not-due');
    clock.advance(3 * DAY);
    await charge(subscriptionId);
    expect((await read(subscriptionId)).subscription.nextChargeAt).toBe('2026-11-28T12:00:00.000Z');
    clock.advance(4 * DAY);
    await charge(subscriptionId);
    expect((await read(subscriptionId)).subscription).toMatchObject({
      status: 'ended',
      endReason: 'dunning',
      failedAttempts: 3,
      nextChargeAt: null,
      paidThrough: dueAt,
    });
    expect(provider.charges.map((c) => c.key.split(':').at(-1))).toEqual(['1', '2', '3']);
    expect(new Set(provider.charges.map((c) => c.key)).size).toBe(3);
    expect((await events(noor.id)).at(-1)).toBe('donation.subscription.ended dunning');
  });

  it('starts counting again after a retry that is paid, from the old period end', async () => {
    const { active, charge, read, provider, to, clock } = setup();
    const { subscriptionId, subscription } = await active();
    provider.chargesAs = 'failed';
    to(subscription.paidThrough!);
    await charge(subscriptionId);
    provider.chargesAs = 'paid';
    clock.advance(3 * DAY);
    await charge(subscriptionId);
    expect((await read(subscriptionId)).subscription).toMatchObject({
      failedAttempts: 0,
      paidThrough: '2026-12-21T12:00:00.000Z',
      nextChargeAt: '2026-12-21T12:00:00.000Z',
    });
  });

  it('asks the provider by key about a charge whose answer never came, and charges once', async () => {
    const { active, charge, read, provider, to, uow, run, clock } = setup();
    const { subscriptionId, subscription } = await active();
    to(subscription.paidThrough!);
    provider.loseNext();
    expect(await charge(subscriptionId)).toBe('unknown');
    expect(await charge(subscriptionId)).toBe('in-flight');
    // Not at once: the request may still be on its way to the provider.
    expect(await uow.run(run, (ctx) => staleChargeAttempts(ctx))).toEqual([]);
    clock.advance(ATTEMPT_RECONCILE_AFTER_MS + 1);
    const stale = await uow.run(run, (ctx) => staleChargeAttempts(ctx));
    expect(stale).toEqual([`subscription:${subscriptionId}:${subscription.paidThrough}:1`]);
    expect(await reconcileChargeAttempt(uow, run, stale[0]!)).toBe('recorded');
    expect(await reconcileChargeAttempt(uow, run, stale[0]!)).toBe('settled');
    expect(provider.charges).toHaveLength(1);
    expect((await read(subscriptionId)).subscription.periodsPaid).toBe(2);
    clock.advance(DAY);
    expect(await uow.run(run, (ctx) => staleChargeAttempts(ctx))).toEqual([]);
  });

  it('closes an attempt the provider never made, and charges the next run with a new key', async () => {
    const { active, charge, provider, to, uow, run, clock } = setup();
    const { subscriptionId, subscription } = await active();
    to(subscription.paidThrough!);
    provider.failNext();
    expect(await charge(subscriptionId)).toBe('unknown');
    const key = `subscription:${subscriptionId}:${subscription.paidThrough}:1`;
    expect(await reconcileChargeAttempt(uow, run, key)).toBe('waiting');
    clock.advance(ATTEMPT_RECONCILE_AFTER_MS + 1);
    expect(await uow.run(run, (ctx) => staleChargeAttempts(ctx))).toEqual([key]);
    expect(await reconcileChargeAttempt(uow, run, key)).toBe('none-made');
    expect(await charge(subscriptionId)).toBe('charged');
    expect(provider.charges.map((c) => c.key.split(':').at(-1))).toEqual(['2']);
  });

  it('counts a charge the provider refuses as a failed attempt, not an unknown one (MY-255)', async () => {
    const { active, charge, read, provider, to, uow, run } = setup();
    const { subscriptionId, subscription } = await active();
    to(subscription.paidThrough!);
    provider.refuseNext();
    expect(await charge(subscriptionId)).toBe('refused');
    const after = await read(subscriptionId);
    expect(after.subscription).toMatchObject({
      status: 'active',
      failedAttempts: 1,
      paidThrough: subscription.paidThrough,
      nextChargeAt: '2026-11-24T12:00:00.000Z',
    });
    expect(after.payments).toHaveLength(1);
    // Nothing waits for the reconciliation: the attempt is closed, the retry gets a new key.
    const attempts = await uow.run(run, (ctx) => ctx.subscriptions.attempts(subscriptionId));
    expect(attempts.map((a) => a.status)).toEqual(['done']);
    to('2026-11-24T12:00:00.000Z');
    expect(await charge(subscriptionId)).toBe('charged');
    expect(provider.charges.map((c) => c.key.split(':').at(-1))).toEqual(['1', '2']);
  });

  it('counts a chargeback as a failed attempt and does not take the period back', async () => {
    const { active, check, read, provider } = setup();
    const { subscriptionId, paymentId, subscription } = await active();
    provider.settle(`fake_${paymentId}`, 'charged_back');
    await check(paymentId);
    expect((await read(subscriptionId)).subscription).toMatchObject({
      status: 'active',
      failedAttempts: 1,
      paidThrough: subscription.paidThrough,
      nextChargeAt: subscription.nextChargeAt,
    });
  });

  it('ends without an event when the first payment fails', async () => {
    const { start, check, read, steps, provider, supporter, events } = setup();
    const noor = await supporter('backs-out@example.org');
    const { subscriptionId, paymentId } = await start({ supporterId: noor.id });
    provider.settle(`fake_${paymentId}`, 'failed', 'canceled');
    await check(paymentId);
    expect((await read(subscriptionId)).subscription).toMatchObject({
      status: 'ended',
      endReason: 'first-payment',
    });
    expect(await steps(subscriptionId)).toEqual([
      '->pending:started:checkout',
      'pending>ended:ended:webhook',
    ]);
    expect(await events(noor.id)).toEqual(['donation.payment.failed']);
  });
});

describe('cancelling', () => {
  it('stops a gift at once, and a second cancel changes nothing', async () => {
    const { active, invoker, admin, charge, to, provider, supporter, events } = setup();
    const noor = await supporter('stops@example.org');
    const { subscriptionId, subscription } = await active({ supporterId: noor.id });
    const cancel = () => invoker.run(useCases.cancelSubscription, admin, { subscriptionId });
    expect((await cancel()).subscription).toMatchObject({
      status: 'cancelled',
      nextChargeAt: null,
    });
    expect((await cancel()).subscription.status).toBe('cancelled');
    to(subscription.paidThrough!);
    expect(await charge(subscriptionId)).toBe('not-due');
    expect(provider.charges).toEqual([]);
    expect((await events(noor.id)).at(-1)).toBe('donation.subscription.cancelled');
  });

  it('stops a membership at the end of its period instead of charging', async () => {
    const { active, invoker, admin, uow, charge, read, steps, to, provider } = setup();
    const { subscriptionId } = await active();
    // PR 4 sells memberships; until then the row is made one here.
    await uow.run(admin, async (ctx) => {
      const sub = (await ctx.subscriptions.get(subscriptionId))!;
      await ctx.subscriptions.insert(
        Subscription.parse({ ...sub, id: exampleId(0x5), kind: 'membership' })
      );
    });
    const member = exampleId(0x5);
    const cancelled = await invoker.run(useCases.cancelSubscription, admin, {
      subscriptionId: member,
    });
    expect(cancelled.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    to(cancelled.subscription.paidThrough!);
    expect(await charge(member)).toBe('cancelled');
    expect((await read(member)).subscription.status).toBe('cancelled');
    expect(await steps(member)).toEqual([
      'active>active:cancel-at-period-end:operator',
      'active>cancelled:cancelled:charge',
    ]);
    expect(provider.charges).toEqual([]);
  });
});

describe('what a subscription needs', () => {
  it('a provider that can charge a mandate', async () => {
    const oneOff = new FakePaymentProvider();
    const provider: PaymentProvider = {
      id: 'one-off',
      createCheckout: (r) => oneOff.createCheckout(r),
      fetchPayment: (ref) => oneOff.fetchPayment(ref),
    };
    const { start } = setup(provider);
    await expectCode(start(), 'conflict');
    expect(oneOff.requests).toEqual([]);
  });

  it('donations:read to read, donations:write to cancel, and the same tenant', async () => {
    const { active, read, invoker, as } = setup();
    const { subscriptionId } = await active();
    const reader = as(['donations:read']);
    expect((await read(subscriptionId, reader)).subscription.id).toBe(subscriptionId);
    await expectCode(read(subscriptionId, as(['supporters:read'])), 'forbidden');
    await expectCode(
      invoker.run(useCases.cancelSubscription, reader, { subscriptionId }),
      'forbidden'
    );
    const other = as(['donations:read'], exampleId(0xbbbb));
    await expectCode(read(subscriptionId, other), 'not_found');
    expect((await invoker.run(useCases.listSubscriptions, other, {})).subscriptions).toEqual([]);
  });
});
