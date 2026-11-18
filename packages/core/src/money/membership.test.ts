// A membership over the memory adapter (ADR 005 rule 8, ADR 016 rule 2, brief MY-254 PR 4): a
// paid tier with prices per interval, a membership form that sells it at the tier's price, the
// `paid` grant every paid period writes until `paidThrough` plus grace, cancelling for the end of
// the period, the prompt that links to the signup page, and the sign-in link from the return
// page. `packages/db/src/money/subscription-rule.ts` holds the Postgres side of the charge run.

import { describe, expect, it } from 'vitest';
import { hasAccess, readerOf } from '../content/access/model.js';
import { accessProjection } from '../content/access/projection.js';
import type { ContentDocument } from '../content/model.js';
import { Invoker } from '../invoke.js';
import { SIGNIN_REQUESTED } from '../readers/model.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { MEMBERSHIP_INTERVAL } from './membership.js';
import { GIVING_NOTICE, selfToken } from './self-service-model.js';
import { chargeSubscription } from './subscriptions.js';

const RETURN = 'http://localhost:5173/probe/donation/{token}';
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const clock = new FakeClock();
  const provider = new FakePaymentProvider();
  const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = principal({
    capabilities: [
      'content:read',
      'content:write',
      'content:publish',
      'forms:read',
      'forms:write',
      'donations:read',
      'donations:write',
      'supporters:read',
      'tenant:admin',
    ],
  });
  const tier = await invoker.run(useCases.createAccessTier, admin, {
    slug: 'vrienden',
    name: { nl: 'Vrienden', en: 'Friends' },
    kind: 'paid',
    prices: { month: 500, year: 5000 },
    signupPath: '/word-lid',
  });
  const form = await invoker.run(useCases.createForm, admin, {
    kind: 'membership',
    tierId: tier.id,
  });
  const join = (values: Record<string, string> = {}, email = 'lid@example.org') =>
    invoker.run(useCases.submitForm, admin, {
      formId: form.id,
      values: { email, ...values },
      locale: 'nl',
      returnUrl: RETURN,
    });
  /** A member whose first payment is paid. */
  const member = async (values: Record<string, string> = {}, email = 'lid@example.org') => {
    const joined = await join(values, email);
    if (joined.status !== 'accepted') throw new Error(joined.status);
    const [payment] = (await invoker.run(useCases.listDonations, admin, {})).donations;
    provider.settle(payment!.providerRef, 'paid');
    await invoker.run(useCases.checkDonation, admin, { paymentId: payment!.id, cause: 'webhook' });
    const [sub] = (await invoker.run(useCases.listSubscriptions, admin, {})).subscriptions;
    const supporter = await invoker.run(useCases.getSupporter, admin, { email });
    return { token: joined.token!, sub: sub!, supporter };
  };
  const projection = (id: string) =>
    uow.run(admin, async (ctx) => (await ctx.supporters.getProjectionById(id))!);
  const article = { access: { level: 'tier' as const, tierIds: [tier.id] } };
  const reads = async (id: string, at: Date) =>
    hasAccess(readerOf(await projection(id)), article, at);
  const run = systemPrincipal(TENANT, 'subscriptions.charge');
  const charge = (id: string) => chargeSubscription(uow, run, id);
  return { clock, provider, uow, invoker, admin, tier, join, member, projection, reads, charge };
}

describe('a paid tier', () => {
  it('carries prices per interval, and a price change raises its version', async () => {
    const { invoker, admin, tier } = await setup();
    expect(tier).toMatchObject({ prices: { month: 500, year: 5000 }, priceVersion: 1 });
    const same = await invoker.run(useCases.updateAccessTier, admin, {
      tierId: tier.id,
      baseUpdatedAt: tier.updatedAt,
      name: tier.name,
      prices: tier.prices,
      signupPath: tier.signupPath,
    });
    expect(same.priceVersion).toBe(1);
    const dearer = await invoker.run(useCases.updateAccessTier, admin, {
      tierId: tier.id,
      baseUpdatedAt: same.updatedAt,
      name: tier.name,
      prices: { month: 600 },
      signupPath: tier.signupPath,
    });
    expect(dearer).toMatchObject({ prices: { month: 600 }, priceVersion: 2 });
  });

  it('is the only kind that has prices', async () => {
    const { invoker, admin } = await setup();
    await expectCode(
      invoker.run(useCases.createAccessTier, admin, {
        slug: 'pers',
        name: { nl: 'Pers' },
        kind: 'free',
        prices: { month: 500 },
      }),
      'invalid_input'
    );
  });
});

describe('a membership form', () => {
  it('sells its tier at the price of the interval picked, and records the price version', async () => {
    const { join, provider, invoker, admin, tier } = await setup();
    expect(await join({ [MEMBERSHIP_INTERVAL]: 'year' })).toMatchObject({ status: 'accepted' });
    expect(provider.requests.at(-1)).toMatchObject({ amount: 5000, sequence: 'first' });
    expect(provider.requests.at(-1)!.description).toBe('Lidmaatschap Vrienden, per jaar');
    const [sub] = (await invoker.run(useCases.listSubscriptions, admin, {})).subscriptions;
    expect(sub).toMatchObject({
      kind: 'membership',
      interval: 'year',
      amount: 5000,
      tierId: tier.id,
      priceVersion: 1,
      status: 'pending',
    });
    expect(await join({})).toMatchObject({ status: 'accepted' });
    expect(provider.requests.at(-1)).toMatchObject({ amount: 500 });
  });

  it('refuses an interval the tier has no price for, and a tier that sells nothing', async () => {
    const { join, invoker, admin, tier } = await setup();
    expect(await join({ [MEMBERSHIP_INTERVAL]: 'week' })).toMatchObject({ status: 'invalid' });
    await invoker.run(useCases.updateAccessTier, admin, {
      tierId: tier.id,
      baseUpdatedAt: tier.updatedAt,
      name: tier.name,
      prices: {},
    });
    await expectCode(join({}), 'conflict');
  });

  it('needs a paid tier of this site', async () => {
    const { invoker, admin } = await setup();
    await expectCode(
      invoker.run(useCases.createForm, admin, { kind: 'membership' }),
      'invalid_input'
    );
    const free = await invoker.run(useCases.createAccessTier, admin, {
      slug: 'pers',
      name: { nl: 'Pers' },
    });
    await expectCode(
      invoker.run(useCases.createForm, admin, { kind: 'membership', tierId: free.id }),
      'invalid_input'
    );
  });
});

describe('a membership', () => {
  it('opens the tier until paidThrough plus grace, and every paid period extends it', async () => {
    const { member, projection, reads, uow, admin, clock, charge } = await setup();
    const { sub, supporter } = await member();
    expect(sub).toMatchObject({ kind: 'membership', status: 'active' });
    const paidThrough = sub.paidThrough!;
    const until = new Date(Date.parse(paidThrough) + 14 * DAY);
    expect((await projection(supporter.id)).grants).toEqual([
      expect.objectContaining({ kind: 'paid', until: until.toISOString() }),
    ]);
    expect(await reads(supporter.id, clock.now())).toBe(true);
    expect(await reads(supporter.id, new Date(until.getTime() - 1))).toBe(true);
    expect(await reads(supporter.id, until)).toBe(false);

    clock.current = new Date(paidThrough);
    expect(await charge(sub.id)).toBe('charged');
    const [renewed] = (await projection(supporter.id)).grants;
    expect(Date.parse(renewed!.until!)).toBeGreaterThan(until.getTime());
    const log = await uow.run(admin, async (ctx) =>
      (await ctx.supporters.eventsFor(supporter.id)).map((e) => e.type)
    );
    // Events of one moment sort by id in the log; the set per moment is what counts.
    expect(log.filter((t) => t.startsWith('membership.') || t === 'access.granted').sort()).toEqual(
      ['access.granted', 'access.granted', 'membership.renewed', 'membership.started']
    );
  });

  it('stops at the end of the period when cancelled, and access runs out on its own', async () => {
    const { member, reads, invoker, uow, admin, clock, provider, charge } = await setup();
    const { sub, supporter } = await member();
    const cancelled = await invoker.run(useCases.cancelSubscription, admin, {
      subscriptionId: sub.id,
    });
    expect(cancelled.subscription).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
    const notices = () =>
      uow.store.outbox.filter((e) => e.type === GIVING_NOTICE).map((e) => e.props['notice']);
    expect(notices()).toEqual(['started', 'cancelled']);
    expect(uow.store.outbox.at(-1)!.props).toMatchObject({
      kind: 'membership',
      paidThrough: sub.paidThrough,
    });

    clock.current = new Date(sub.paidThrough!);
    expect(await charge(sub.id)).toBe('cancelled');
    expect(provider.charges).toHaveLength(0);
    const ended = await invoker.run(useCases.getSubscription, admin, { subscriptionId: sub.id });
    expect(ended.subscription.status).toBe('cancelled');
    // Read through the grace, then not.
    expect(await reads(supporter.id, new Date(Date.parse(sub.paidThrough!) + 13 * DAY))).toBe(true);
    expect(await reads(supporter.id, new Date(Date.parse(sub.paidThrough!) + 14 * DAY))).toBe(
      false
    );
    expect(notices()).toEqual(['started', 'cancelled']);
    const log = await uow.run(admin, async (ctx) =>
      (await ctx.supporters.eventsFor(supporter.id))
        .filter((e) => e.type === 'membership.ended')
        .map((e) => e.props['reason'])
    );
    expect(log).toEqual(['cancelled']);
  });

  it('cannot be paused or changed in amount by its member, only cancelled', async () => {
    const { member, invoker, uow } = await setup();
    const { sub } = await member();
    const reader = anonymousPrincipal(TENANT, ['content:read']);
    const token = await uow.run(reader, (ctx) =>
      selfToken(ctx.signer, TENANT, sub.supporterId!, new Date(ctx.clock.now().getTime() + DAY))
    );
    const own = await invoker.run(useCases.getOwnGifts, reader, { token });
    expect(own.gifts).toEqual([
      expect.objectContaining({
        kind: 'membership',
        tier: expect.objectContaining({ name: { nl: 'Vrienden', en: 'Friends' } }),
        cancelAtPeriodEnd: false,
      }),
    ]);
    await expectCode(
      invoker.run(useCases.updateOwnGift, reader, {
        token,
        subscriptionId: sub.id,
        action: 'pause',
      }),
      'conflict'
    );
    const done = await invoker.run(useCases.updateOwnGift, reader, {
      token,
      subscriptionId: sub.id,
      action: 'cancel',
    });
    expect(done.gift).toMatchObject({ status: 'active', cancelAtPeriodEnd: true });
  });

  it('is never given by hand as paid access', async () => {
    const { member, invoker, admin, tier } = await setup();
    const { supporter } = await member();
    await expectCode(
      invoker.run(useCases.createAccessGrant, admin, {
        supporterId: supporter.id,
        tierId: tier.id,
        kind: 'paid' as 'comp',
        reason: 'test',
      }),
      'invalid_input'
    );
  });
});

describe('the way in', () => {
  it('links the prompt of a restricted item to the signup page of its paid tier', async () => {
    const { uow, tier } = await setup();
    const visitor = anonymousPrincipal(TENANT, ['content:read']);
    const doc = {
      type: 'page',
      access: { level: 'tier', tierIds: [tier.id], teaser: 'lead' },
      blocks: [],
    } as unknown as ContentDocument;
    const { gate } = await uow.run(visitor, (ctx) => accessProjection(ctx, doc));
    expect(gate).toEqual({ prompt: 'signin', join: '/word-lid' });
  });

  it('mails a sign-in link from the return page of a paid membership, never signs in', async () => {
    const { member, invoker, uow } = await setup();
    const { token } = await member();
    const visitor = anonymousPrincipal(TENANT, ['donations:write']);
    const before = uow.store.outbox.filter((e) => e.type === SIGNIN_REQUESTED).length;
    expect(
      await invoker.run(useCases.requestMemberSignin, visitor, { token, locale: 'nl' })
    ).toEqual({ status: 'accepted' });
    expect(uow.store.outbox.filter((e) => e.type === SIGNIN_REQUESTED)).toHaveLength(before + 1);
    // One a day per address, and the answer is the same.
    await invoker.run(useCases.requestMemberSignin, visitor, { token, locale: 'nl' });
    expect(uow.store.outbox.filter((e) => e.type === SIGNIN_REQUESTED)).toHaveLength(before + 1);
    await expectCode(
      invoker.run(useCases.requestMemberSignin, visitor, { token: 'forged', locale: 'nl' }),
      'not_found'
    );
  });

  it('sends nothing for the return page of a gift', async () => {
    const { uow, invoker, admin } = await setup();
    const gift = await invoker.run(useCases.createForm, admin, { kind: 'donation' });
    const given = await invoker.run(useCases.submitForm, admin, {
      formId: gift.id,
      values: { email: 'gever@example.org', amount: '10' },
      locale: 'nl',
      returnUrl: RETURN,
    });
    const visitor = anonymousPrincipal(TENANT, ['donations:write']);
    await invoker.run(useCases.requestMemberSignin, visitor, {
      token: (given as { token: string }).token,
      locale: 'nl',
    });
    expect(uow.store.outbox.filter((e) => e.type === SIGNIN_REQUESTED)).toHaveLength(0);
  });
});
