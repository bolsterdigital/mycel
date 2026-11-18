// The subscription scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedSubscription`). In a file of its own
// because the suite is at its size ceiling; it makes its own tenants and supporters.

import {
  SupporterEvent,
  anonymousPrincipal,
  chargeSubscription,
  ingest,
  reconcileChargeAttempt,
  selfToken,
  staleChargeAttempts,
  startSubscription,
  systemPrincipal,
  useCases,
  type Invoker,
  type UnitOfWork,
} from '@mycel/core';
import { expectedMembership, observeMembership } from './membership-rule.js';

/** The fake clock of the suite: the scenario moves it to the end of each period. */
interface Clock {
  now(): Date;
  advance(ms: number): void;
}

/** The fake provider of the suite: the scenario plays the donor and the bank. */
interface Provider {
  settle(ref: string, outcome: 'paid' | 'failed'): void;
  chargesAs: 'open' | 'paid' | 'failed' | 'expired' | 'refunded' | 'charged_back';
  loseNext(late?: boolean): void;
  land(): void;
  readonly charges: readonly { key: string }[];
}

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/**
 * Starting, the first payment paid → active, a charge paid → one period on, a charge whose answer
 * never came and whose request reached the provider late reconciled by key, after the wait, without
 * a second charge, failed charges → retries → `ended`,
 * cancelling, an erased giver whose subscription ends and whose mandate stops, and another tenant
 * that sees none of it (brief MY-254 PR 1). Then the giver's own link (PR 3): a new amount, a pause
 * and a resume, each one ledger step with cause `donor`; the same supporter's link for another
 * site reaches nothing.
 */
export async function observeSubscription(
  invoker: Invoker,
  uow: UnitOfWork,
  provider: Provider,
  clock: Clock,
  erase: (tenantId: string) => Promise<unknown>,
  tenant: () => Promise<string>
) {
  const admin = systemPrincipal(await tenant(), 'adapter-rules');
  const other = systemPrincipal(await tenant(), 'adapter-rules');
  const run = systemPrincipal(admin.tenantId, 'subscriptions.charge');
  const supporter = async (email: string) => {
    await uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `subscription-rule:${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: `subscription-rule:${email}`,
          props: { list: 'news' },
        })
      )
    );
    return invoker.run(useCases.getSupporter, admin, { email });
  };
  const start = (amount: number, supporterId?: string) =>
    uow.run(admin, (ctx) =>
      startSubscription(ctx, {
        amount,
        currency: 'EUR',
        description: 'Monthly gift',
        locale: 'nl',
        returnUrl: 'http://localhost:5173/probe/donation/{token}',
        interval: 'month',
        ...(supporterId ? { supporterId } : {}),
      })
    );
  const settle = async (paymentId: string, outcome: 'paid' | 'failed') => {
    provider.settle(`fake_${paymentId}`, outcome);
    await invoker.run(useCases.checkDonation, admin, { paymentId, cause: 'webhook' });
  };
  const read = (subscriptionId: string) =>
    invoker.run(useCases.getSubscription, admin, { subscriptionId });
  const sub = async (id: string) => (await read(id)).subscription;
  const steps = async (id: string) =>
    (await read(id)).ledger.map((e) => `${e.from ?? '-'}>${e.to}:${e.step}:${e.cause}`);
  const charge = (id: string) => chargeSubscription(uow, run, id);
  const until = (at: string) => clock.advance(Date.parse(at) - clock.now().getTime());
  const chargesOf = (id: string) => provider.charges.filter((c) => c.key.includes(id)).length;

  // A membership (PR 4) charges like a gift and grants its tier per paid period.
  const membership = await observeMembership(invoker, uow, provider, clock, tenant);
  const noor = await supporter('noor-monthly@example.org');
  const gone = await supporter('gone-monthly@example.org');
  const monthly = await start(1000, noor.id);
  const leaving = await start(2000, gone.id);
  const lapsed = await start(500);
  const stopping = await start(700);
  const pending = (await sub(monthly.subscriptionId)).status;
  for (const s of [monthly, leaving, stopping]) await settle(s.paymentId, 'paid');
  await settle(lapsed.paymentId, 'failed');
  const first = await sub(monthly.subscriptionId);

  until(first.paidThrough!);
  const charged = await charge(monthly.subscriptionId);
  const again = await charge(monthly.subscriptionId);
  const renewed = await sub(monthly.subscriptionId);
  // The answer is lost and the request has not reached the provider yet: asking at once would
  // hear "made nothing" and charge the period again with a new key (review of MY-254 PR 1).
  provider.loseNext(true);
  const lost = await charge(leaving.subscriptionId);
  const inFlight = await charge(leaving.subscriptionId);
  const staleAtOnce = (await uow.run(run, (ctx) => staleChargeAttempts(ctx))).length;
  const [lostAttempt] = await uow.run(admin, (ctx) =>
    ctx.subscriptions.attempts(leaving.subscriptionId)
  );
  const early = await reconcileChargeAttempt(uow, run, lostAttempt!.key);
  provider.land();
  clock.advance(16 * MINUTE);
  const stale = await uow.run(run, (ctx) => staleChargeAttempts(ctx));
  const reconciled = stale.length ? await reconcileChargeAttempt(uow, run, stale[0]!) : null;
  const afterwards = await charge(leaving.subscriptionId);

  provider.chargesAs = 'failed';
  until(renewed.paidThrough!);
  await charge(monthly.subscriptionId);
  clock.advance(3 * DAY);
  await charge(monthly.subscriptionId);
  clock.advance(4 * DAY);
  await charge(monthly.subscriptionId);
  provider.chargesAs = 'paid';
  const dunned = await sub(monthly.subscriptionId);

  const cancelled = await invoker.run(useCases.cancelSubscription, admin, {
    subscriptionId: stopping.subscriptionId,
  });
  await uow.run(admin, (ctx) => ctx.erasures.register(gone.id, gone.email));
  await erase(admin.tenantId);
  const erased = await read(leaving.subscriptionId);
  const mandate = await uow.run(admin, (ctx) =>
    ctx.subscriptions.getMandate(erased.subscription.mandateId!)
  );
  // The giver's own link (PR 3), as a visitor of the site with a token from a mail. A minute on,
  // so its events do not share a moment with the dunning's end (the log orders a tie by id).
  clock.advance(MINUTE);
  const own = await start(1200, noor.id);
  await settle(own.paymentId, 'paid');
  const link = await uow.run(admin, (ctx) =>
    selfToken(ctx.signer, admin.tenantId, noor.id, new Date(clock.now().getTime() + DAY))
  );
  const elsewhere = await uow.run(other, (ctx) =>
    selfToken(ctx.signer, other.tenantId, noor.id, new Date(clock.now().getTime() + DAY))
  );
  const visitor = (tenantId: string) => anonymousPrincipal(tenantId, ['content:read']);
  const self = (action: 'amount' | 'pause' | 'resume', amount?: number) =>
    invoker.run(useCases.updateOwnGift, visitor(admin.tenantId), {
      token: link,
      subscriptionId: own.subscriptionId,
      action,
      ...(amount ? { amount } : {}),
    });
  await self('amount', 1500);
  await self('pause');
  const resumed = (await self('resume')).gift;
  const ownGifts = (
    await invoker.run(useCases.getOwnGifts, visitor(admin.tenantId), { token: link })
  ).gifts.map((g) => `${g.amount} ${g.status}`);

  const missing = (p: Promise<unknown>) =>
    p.then(
      () => 'found',
      (e: { code: string }) => e.code
    );

  return {
    membership,
    started: {
      status: pending,
      firstSequence: (await read(monthly.subscriptionId)).payments.at(-1)?.sequence,
    },
    active: {
      status: first.status,
      periodsPaid: first.periodsPaid,
      mandate: first.mandateId !== null,
      dueAtPeriodEnd: first.nextChargeAt === first.paidThrough,
    },
    charged,
    again,
    renewed: {
      periodsPaid: renewed.periodsPaid,
      oneMonthOn: renewed.paidThrough!.slice(5, 7) !== first.paidThrough!.slice(5, 7),
    },
    lost: {
      lost,
      inFlight,
      staleAtOnce,
      early,
      stale: stale.length,
      reconciled,
      afterwards,
      charges: chargesOf(leaving.subscriptionId),
    },
    dunned: {
      status: dunned.status,
      endReason: dunned.endReason,
      failedAttempts: dunned.failedAttempts,
      paidThroughKept: dunned.paidThrough === renewed.paidThrough,
      charges: chargesOf(monthly.subscriptionId),
    },
    monthlySteps: await steps(monthly.subscriptionId),
    lapsed: {
      status: (await sub(lapsed.subscriptionId)).endReason,
      steps: await steps(lapsed.subscriptionId),
    },
    cancelled: { status: cancelled.subscription.status, next: cancelled.subscription.nextChargeAt },
    events: await uow.run(admin, async (ctx) =>
      (await ctx.supporters.eventsFor(noor.id))
        .filter((e) => e.type.startsWith('donation.subscription'))
        .map((e) => `${e.type} ${String(e.props['reason'] ?? '')}`.trim())
    ),
    erased: {
      status: erased.subscription.status,
      endReason: erased.subscription.endReason,
      supporterId: erased.subscription.supporterId,
      next: erased.subscription.nextChargeAt,
      lastStep: (await steps(leaving.subscriptionId)).at(-1),
      payments: erased.payments.map((p) => [p.sequence, p.supporterId]),
      mandate: { status: mandate?.status, supporterId: mandate?.supporterId },
    },
    listed: (await invoker.run(useCases.listSubscriptions, admin, {})).subscriptions.map(
      (s) => `${s.amount} ${s.status}`
    ),
    activeOnly: (await invoker.run(useCases.listSubscriptions, admin, { status: 'active' }))
      .subscriptions.length,
    otherTenantList: (await invoker.run(useCases.listSubscriptions, other, {})).subscriptions
      .length,
    otherTenantGet: await missing(
      invoker.run(useCases.getSubscription, other, { subscriptionId: monthly.subscriptionId })
    ),
    otherTenantCancel: await missing(
      invoker.run(useCases.cancelSubscription, other, { subscriptionId: monthly.subscriptionId })
    ),
    own: {
      gifts: ownGifts,
      steps: (await steps(own.subscriptionId)).slice(2),
      dueAtPeriodEnd: resumed.nextChargeAt === resumed.paidThrough,
      otherSite: await missing(
        invoker.run(useCases.getOwnGifts, visitor(other.tenantId), { token: elsewhere })
      ),
      otherSiteToken: await missing(
        invoker.run(useCases.getOwnGifts, visitor(admin.tenantId), { token: elsewhere })
      ),
    },
  };
}

export const expectedSubscription = {
  membership: expectedMembership,
  started: { status: 'pending', firstSequence: 'first' },
  active: { status: 'active', periodsPaid: 1, mandate: true, dueAtPeriodEnd: true },
  charged: 'charged',
  again: 'not-due',
  renewed: { periodsPaid: 2, oneMonthOn: true },
  lost: {
    lost: 'unknown',
    inFlight: 'in-flight',
    staleAtOnce: 0,
    early: 'waiting',
    stale: 1,
    reconciled: 'recorded',
    afterwards: 'not-due',
    charges: 1,
  },
  dunned: {
    status: 'ended',
    endReason: 'dunning',
    failedAttempts: 3,
    paidThroughKept: true,
    charges: 4,
  },
  monthlySteps: [
    '->pending:started:checkout',
    'pending>active:activated:webhook',
    'active>active:renewed:charge',
    'active>active:charge-failed:charge',
    'active>active:charge-failed:charge',
    'active>ended:ended:charge',
  ],
  lapsed: {
    status: 'first-payment',
    steps: ['->pending:started:checkout', 'pending>ended:ended:webhook'],
  },
  cancelled: { status: 'cancelled', next: null },
  events: [
    'donation.subscription.started',
    'donation.subscription.ended dunning',
    // The gift she manages with her own link below.
    'donation.subscription.started',
  ],
  erased: {
    status: 'ended',
    endReason: 'erasure',
    supporterId: null,
    next: null,
    lastStep: 'active>ended:ended:erasure',
    payments: [
      ['recurring', null],
      ['first', null],
    ],
    mandate: { status: 'invalid', supporterId: null },
  },
  listed: ['1500 active', '700 cancelled', '500 ended', '2000 ended', '1000 ended'],
  activeOnly: 1,
  otherTenantList: 0,
  otherTenantGet: 'not_found',
  otherTenantCancel: 'not_found',
  own: {
    // Noor's monthly gift ended in dunning before; the page shows both.
    gifts: ['1500 active', '1000 ended'],
    steps: [
      'active>active:amount-changed:donor',
      'active>paused:paused:donor',
      'paused>active:resumed:donor',
    ],
    dueAtPeriodEnd: true,
    otherSite: 'not_found',
    otherSiteToken: 'not_found',
  },
};
