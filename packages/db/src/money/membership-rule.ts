// The membership scenario of the adapter rules (brief MY-254 PR 4), run from the subscription
// scenario over the memory adapter and over Postgres: a paid tier whose prices survive the round
// trip and whose version goes up with a price change, a membership that grants the tier for each
// paid period until `paidThrough` plus grace, a cancel for the end of the period that the charge
// run carries out without charging, and another tenant that sees none of it.

import {
  SupporterEvent,
  chargeSubscription,
  hasAccess,
  ingest,
  readerOf,
  startSubscription,
  systemPrincipal,
  useCases,
  type Invoker,
  type UnitOfWork,
} from '@mycel/core';

interface Clock {
  now(): Date;
  advance(ms: number): void;
}

interface Provider {
  settle(ref: string, outcome: 'paid' | 'failed'): void;
  readonly charges: readonly { key: string }[];
}

const DAY = 24 * 60 * 60 * 1000;

export async function observeMembership(
  invoker: Invoker,
  uow: UnitOfWork,
  provider: Provider,
  clock: Clock,
  tenant: () => Promise<string>
) {
  // From today, not from where the earlier scenarios left the clock: two months on from there
  // would leave the events' partitions (events_default must stay empty). Put back at the end.
  const origin = clock.now().getTime();
  clock.advance(Date.now() - origin);
  const admin = systemPrincipal(await tenant(), 'adapter-rules');
  const other = systemPrincipal(await tenant(), 'adapter-rules');
  const run = systemPrincipal(admin.tenantId, 'subscriptions.charge');
  const email = 'lid-rule@example.org';
  await uow.run(admin, (ctx) =>
    ingest(
      ctx,
      SupporterEvent.parse({
        schema: 'wings.supporter-event.v1',
        id: `membership-rule:${email}`,
        type: 'newsletter.subscribed',
        email,
        occurred_at: clock.now().toISOString(),
        source: 'test',
        source_site: 'urn:mycel:test',
        source_ref: `membership-rule:${email}`,
        props: { list: 'news' },
      })
    )
  );
  const member = await invoker.run(useCases.getSupporter, admin, { email });

  const created = await invoker.run(useCases.createAccessTier, admin, {
    slug: 'vrienden',
    name: { nl: 'Vrienden' },
    kind: 'paid',
    prices: { month: 500, year: 5000 },
    signupPath: '/word-lid',
  });
  const tier = await invoker.run(useCases.updateAccessTier, admin, {
    tierId: created.id,
    baseUpdatedAt: created.updatedAt,
    name: created.name,
    prices: { month: 600, year: 5000 },
    signupPath: created.signupPath,
  });
  const started = await uow.run(admin, (ctx) =>
    startSubscription(ctx, {
      amount: tier.prices.month!,
      currency: 'EUR',
      description: 'Lidmaatschap Vrienden',
      locale: 'nl',
      returnUrl: 'http://localhost:5173/probe/donation/{token}',
      interval: 'month',
      supporterId: member.id,
      membership: { tierId: tier.id, priceVersion: tier.priceVersion },
    })
  );
  provider.settle(`fake_${started.paymentId}`, 'paid');
  await invoker.run(useCases.checkDonation, admin, {
    paymentId: started.paymentId,
    cause: 'webhook',
  });
  const read = async () =>
    (await invoker.run(useCases.getSubscription, admin, { subscriptionId: started.subscriptionId }))
      .subscription;
  const grantOf = async () =>
    (await invoker.run(useCases.getSupporter, admin, { email })).grants.map((g) => ({
      kind: g.kind,
      graceDays: (Date.parse(g.until!) - Date.parse(paidThrough)) / DAY,
    }));
  const first = await read();
  let paidThrough = first.paidThrough!;
  const firstGrant = await grantOf();

  clock.advance(Date.parse(paidThrough) - clock.now().getTime());
  const renewal = await chargeSubscription(uow, run, started.subscriptionId);
  const renewed = await read();
  paidThrough = renewed.paidThrough!;
  const renewedGrant = await grantOf();

  const cancel = await invoker.run(useCases.cancelSubscription, admin, {
    subscriptionId: started.subscriptionId,
  });
  clock.advance(Date.parse(paidThrough) - clock.now().getTime());
  const charges = provider.charges.length;
  const atEnd = await chargeSubscription(uow, run, started.subscriptionId);
  const ended = await read();
  const reader = readerOf(
    await uow.run(admin, (ctx) => ctx.supporters.getProjectionById(member.id))
  );
  const item = { access: { level: 'tier' as const, tierIds: [tier.id] } };
  const reads = (days: number) =>
    hasAccess(reader, item, new Date(Date.parse(paidThrough) + days * DAY));

  const events = await uow.run(admin, async (ctx) =>
    (await ctx.supporters.eventsFor(member.id))
      .filter((e) => e.type.startsWith('membership.') || e.type === 'access.granted')
      .map((e) => `${e.type} ${String(e.props['reason'] ?? e.props['kind'] ?? '')}`.trim())
      // Events of one moment sort by id in the log; the set per moment is what counts.
      .sort()
  );
  const otherTenant = (await invoker.run(useCases.listAccessTiers, other, {})).tiers.length;
  clock.advance(origin - clock.now().getTime());

  return {
    tier: { prices: tier.prices, priceVersion: tier.priceVersion, signupPath: tier.signupPath },
    started: {
      kind: first.kind,
      status: first.status,
      amount: first.amount,
      priceVersion: first.priceVersion,
      tier: first.tierId === tier.id,
    },
    firstGrant,
    renewal,
    renewedGrant,
    cancel: {
      status: cancel.subscription.status,
      atPeriodEnd: cancel.subscription.cancelAtPeriodEnd,
    },
    atEnd,
    noChargeAtEnd: provider.charges.length === charges,
    ended: ended.status,
    reads: { lastGraceDay: reads(13), afterGrace: reads(14) },
    events,
    otherTenant,
  };
}

export const expectedMembership = {
  tier: { prices: { month: 600, year: 5000 }, priceVersion: 2, signupPath: '/word-lid' },
  started: { kind: 'membership', status: 'active', amount: 600, priceVersion: 2, tier: true },
  firstGrant: [{ kind: 'paid', graceDays: 14 }],
  renewal: 'charged',
  renewedGrant: [{ kind: 'paid', graceDays: 14 }],
  cancel: { status: 'active', atPeriodEnd: true },
  atEnd: 'cancelled',
  noChargeAtEnd: true,
  ended: 'cancelled',
  reads: { lastGraceDay: true, afterGrace: false },
  events: [
    'access.granted paid',
    'access.granted paid',
    'membership.ended cancelled',
    'membership.renewed',
    'membership.started',
  ],
  otherTenant: 0,
};
