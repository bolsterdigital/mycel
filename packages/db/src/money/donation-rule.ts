// The donation scenario of the adapter rules (adapter-rules.test.ts runs it over the memory
// adapter and over Postgres and compares both with `expectedDonation`). In a file of its own
// because the suite is at its size ceiling; it ingests its own supporters.

import {
  SupporterEvent,
  ingest,
  useCases,
  type Invoker,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';

/** The fake clock of the suite: the scenario moves it on between its payments. */
interface Clock {
  now(): Date;
  advance(ms: number): void;
}

/** The fake provider of the suite: the scenario plays the donor's side of a payment. */
interface Provider {
  settle(ref: string, outcome: 'paid' | 'failed' | 'refunded', raw?: string): void;
}

const RETURN = 'http://localhost:5173/probe/donation/{token}';

/**
 * `donation.create|check|get|list` (ADR 005): a checkout opens the payment, a check walks it to
 * where the provider says it stands with one ledger entry per step and writes nothing the second
 * time; a settled payment is one event in the supporter's log; an erasure keeps the payment and
 * its ledger and clears who gave; another tenant sees none of it.
 */
export async function observeDonation(
  invoker: Invoker,
  uow: UnitOfWork,
  provider: Provider,
  admin: Principal,
  other: Principal,
  clock: Clock,
  erase: (tenantId: string) => Promise<unknown>
) {
  const supporter = async (email: string) => {
    await uow.run(admin, (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `donation-rule:${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: `donation-rule:${email}`,
          props: { list: 'news' },
        })
      )
    );
    return invoker.run(useCases.getSupporter, admin, { email });
  };
  const give = (amount: number, supporterId?: string) =>
    invoker.run(useCases.createDonation, admin, {
      amount,
      currency: 'EUR',
      description: 'Donation',
      locale: 'nl',
      returnUrl: RETURN,
      ...(supporterId ? { supporterId } : {}),
    });
  const check = (paymentId: string) =>
    invoker.run(useCases.checkDonation, admin, { paymentId, cause: 'webhook' });
  const read = (paymentId: string, by = admin) =>
    invoker.run(useCases.getDonation, by, { paymentId });
  const steps = async (paymentId: string) =>
    (await read(paymentId)).ledger.map((e) => `${e.from ?? '-'}>${e.to}:${e.cause}`);
  const donationEvents = (supporterId: string) =>
    uow.run(admin, async (ctx) =>
      (await ctx.supporters.eventsFor(supporterId))
        .filter((e) => e.type.startsWith('donation.'))
        .map((e) => `${e.type} ${String(e.props['amount'])} ${String(e.props['currency'])}`)
    );

  const noor = await supporter('noor-gift@example.org');
  const gone = await supporter('gone-gift@example.org');

  const anonymous = await give(1000);
  clock.advance(1000);
  const known = await give(2500, noor.id);
  clock.advance(1000);
  const leaving = await give(4000, gone.id);
  clock.advance(1000);
  const lapsed = await give(500);

  const opened = await read(known.paymentId);
  provider.settle(`fake_${known.paymentId}`, 'paid');
  const paid = await check(known.paymentId);
  const again = await check(known.paymentId);
  provider.settle(`fake_${leaving.paymentId}`, 'paid');
  await check(leaving.paymentId);
  // A report that skipped a step, and a donor who backed out in the provider's own word.
  provider.settle(`fake_${anonymous.paymentId}`, 'refunded');
  await check(anonymous.paymentId);
  provider.settle(`fake_${lapsed.paymentId}`, 'failed', 'canceled');
  const byToken = await invoker.run(useCases.checkDonation, admin, {
    token: lapsed.token,
    cause: 'return',
  });

  const list = (input: { status?: 'paid' | 'failed'; supporterId?: string; limit?: number } = {}) =>
    invoker.run(useCases.listDonations, admin, input);
  const beforeErasure = (await read(leaving.paymentId)).donation.supporterId === gone.id;
  await uow.run(admin, (ctx) => ctx.erasures.register(gone.id, gone.email));
  await erase(admin.tenantId);
  const erased = await read(leaving.paymentId);
  // `donation.summary.get` over the same ledger: the refund taken off; the erasure changes no
  // money.
  const summary = (by: Principal) =>
    invoker.run(useCases.getDonationSummary, by, {
      timeZone: 'UTC',
      until: clock.now().toISOString(),
    });

  return {
    started: {
      status: known.status,
      checkout: known.checkoutUrl === `https://pay.example/checkout/fake_${known.paymentId}`,
      stored: opened.donation.status,
      provider: opened.donation.provider,
      ref: opened.donation.providerRef === `fake_${known.paymentId}`,
    },
    paid: { status: paid.status, amount: paid.amount, currency: paid.currency },
    paidOnce: again.paidAt === paid.paidAt,
    paidSteps: await steps(known.paymentId),
    skippedSteps: await steps(anonymous.paymentId),
    backedOut: {
      status: byToken.status,
      raw: (await read(lapsed.paymentId)).donation.providerStatus,
      steps: await steps(lapsed.paymentId),
    },
    events: await donationEvents(noor.id),
    newestFirst: (await list()).donations.map((d) => d.amount),
    paidOnly: (await list({ status: 'paid' })).donations.map((d) => d.amount),
    ofSupporter: (await list({ supporterId: noor.id })).donations.map((d) => d.amount),
    firstPage: await list({ limit: 3 }).then((p) => ({
      amounts: p.donations.map((d) => d.amount),
      nextOffset: p.nextOffset,
    })),
    beforeErasure,
    erased: {
      supporterId: erased.donation.supporterId,
      status: erased.donation.status,
      amount: erased.donation.amount,
      ledger: erased.ledger.length,
    },
    summary: await summary(admin).then((s) => ({ currencies: s.currencies, running: s.running })),
    otherTenantSummary: (await summary(other)).currencies,
    otherTenantList: (await invoker.run(useCases.listDonations, other, {})).donations.length,
    otherTenantGet: await read(known.paymentId, other).then(
      () => 'found',
      (e: { code: string }) => e.code
    ),
    otherTenantCheck: await invoker
      .run(useCases.checkDonation, other, { token: known.token, cause: 'return' })
      .then(
        () => 'found',
        (e: { code: string }) => e.code
      ),
  };
}

export const expectedDonation = {
  started: { status: 'open', checkout: true, stored: 'open', provider: 'fake', ref: true },
  paid: { status: 'paid', amount: 2500, currency: 'EUR' },
  paidOnce: true,
  paidSteps: ['->created:checkout', 'created>open:checkout', 'open>paid:webhook'],
  skippedSteps: [
    '->created:checkout',
    'created>open:checkout',
    'open>paid:webhook',
    'paid>refunded:webhook',
  ],
  backedOut: {
    status: 'failed',
    raw: 'canceled',
    steps: ['->created:checkout', 'created>open:checkout', 'open>failed:return'],
  },
  events: ['donation.payment.succeeded 2500 EUR'],
  newestFirst: [500, 4000, 2500, 1000],
  paidOnly: [4000, 2500],
  ofSupporter: [2500],
  firstPage: { amounts: [500, 4000, 2500], nextOffset: 3 },
  beforeErasure: true,
  erased: { supporterId: null, status: 'paid', amount: 4000, ledger: 3 },
  summary: {
    currencies: [
      {
        currency: 'EUR',
        month: { net: 6500, returned: 1000, gifts: 3 },
        previousMonth: { net: 0, returned: 0, gifts: 0 },
      },
    ],
    running: { donations: 0, memberships: 0 },
  },
  otherTenantSummary: [],
  otherTenantList: 0,
  otherTenantGet: 'not_found',
  otherTenantCheck: 'not_found',
};
