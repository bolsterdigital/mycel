// A fundraiser (ADR 033 rule 8, amendment 2026-11-17) over the memory adapter: its donation form
// takes part like any bound form (rule 3 decides at submit), the payment names the campaign, and
// the counter is the sum of the paid payments. No signature, so no confirmation mail and no
// participation row; a refund lowers the total, an erasure does not. The Postgres sum is in
// `packages/db/src/money/donation-rule.ts`.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal } from '../principal.js';
import {
  FakeClock,
  FakePaymentProvider,
  MemoryUnitOfWork,
  TENANT,
  expectCode,
  principal,
} from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { PARTICIPATION_REQUESTED } from '../forms/events.js';
import type { ProviderOutcome } from '../money/ports.js';

const RETURN = 'http://localhost:5173/probe/donation/{token}';

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
      'supporters:write',
      'supporters:erase',
    ],
  });
  let campaign = await invoker.run(useCases.composeCampaign, admin, {
    kind: 'fundraiser',
    title: { nl: 'Geef voor het park' },
    defaultLocale: 'nl',
    locales: ['nl'],
    goal: { target: 10_000, milestones: [] },
  });
  const { item } = await invoker.run(useCases.getItem, admin, {
    itemId: campaign.landingItemId,
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: item.latestRevisionId,
    locale: 'nl',
  });
  const step = async (useCase: typeof useCases.openCampaign) =>
    (campaign = await invoker.run(useCase, admin, {
      campaignId: campaign.id,
      baseUpdatedAt: campaign.updatedAt,
    }));
  await step(useCases.openCampaign);
  const give = async (email: string, euros: string) => {
    const result = await invoker.run(useCases.submitForm, admin, {
      formId: campaign.formId!,
      values: { email, amount: euros },
      locale: 'nl',
      returnUrl: RETURN,
    });
    if (result.status !== 'accepted') throw new Error(`not accepted: ${result.status}`);
    const { donations } = await invoker.run(useCases.listDonations, admin, {});
    return donations.find((d) => d.submissionId === result.submissionId)!;
  };
  const settle = async (paymentId: string, outcome: ProviderOutcome) => {
    provider.settle(`fake_${paymentId}`, outcome);
    return invoker.run(useCases.checkDonation, admin, { paymentId, cause: 'webhook' });
  };
  const read = () => invoker.run(useCases.getCampaign, admin, { campaignId: campaign.id });
  const card = () =>
    invoker.run(useCases.getCampaignCard, admin, { campaignId: campaign.id, locale: 'nl' });
  return { uow, invoker, admin, give, settle, read, card, step, campaign: () => campaign };
}

describe('a fundraiser', () => {
  it('counts paid money only: an open checkout and a failed gift add nothing', async () => {
    const t = await setup();
    const first = await t.give('ans@example.org', '25');
    const second = await t.give('bob@example.org', '10');
    expect(first).toMatchObject({ status: 'open', amount: 2500, campaignId: t.campaign().id });
    expect((await t.read()).raised).toEqual({ amount: 0, currency: 'EUR' });

    await t.settle(first.id, 'paid');
    await t.settle(second.id, 'failed');
    expect(await t.read()).toMatchObject({
      participants: 1,
      raised: { amount: 2500, currency: 'EUR' },
    });
    const card = await t.card();
    expect(card).toMatchObject({
      available: true,
      kind: 'fundraiser',
      phase: 'open',
      formId: t.campaign().formId,
      counter: { participants: 1, raised: { amount: 2500, currency: 'EUR' }, target: 10_000 },
    });
  });

  it('asks for no signature: no confirmation mail and no participation row', async () => {
    const t = await setup();
    const gift = await t.give('ans@example.org', '25');
    expect(t.uow.store.outbox.map((e) => e.type)).not.toContain(PARTICIPATION_REQUESTED);
    const s = t.uow.store.for(TENANT);
    expect(s.participations.size).toBe(0);
    const submission = await t.uow.run(systemPrincipal(TENANT, 'test'), (ctx) =>
      ctx.submissions.findById(gift.submissionId!)
    );
    expect(submission?.evaluation?.campaignId).toBeUndefined();
  });

  it('lowers the total for a refund, and keeps it through an erasure', async () => {
    const t = await setup();
    const kept = await t.give('ans@example.org', '50');
    const refunded = await t.give('bob@example.org', '10');
    await t.settle(kept.id, 'paid');
    await t.settle(refunded.id, 'paid');
    expect((await t.read()).raised?.amount).toBe(6000);
    await t.settle(refunded.id, 'refunded');
    expect((await t.read()).raised?.amount).toBe(5000);

    const { donations } = await t.invoker.run(useCases.listDonations, t.admin, {});
    const giver = donations.find((d) => d.id === kept.id)!.supporterId!;
    await t.invoker.run(useCases.eraseSupporter, t.admin, { supporterId: giver });
    await t.uow.run(systemPrincipal(TENANT, 'test'), (ctx) => ctx.erasures.apply());
    const after = await t.invoker.run(useCases.getDonation, t.admin, { paymentId: kept.id });
    expect(after.donation).toMatchObject({ supporterId: null, campaignId: t.campaign().id });
    expect(await t.read()).toMatchObject({ participants: 1, raised: { amount: 5000 } });
  });

  it('starts from no earlier count: money comes from the ledger only (MY-288 PR B)', async () => {
    const t = await setup();
    await expectCode(
      t.invoker.run(useCases.updateCampaign, t.admin, {
        campaignId: t.campaign().id,
        baseUpdatedAt: (await t.read()).updatedAt,
        startingCount: 50,
      }),
      'invalid_input',
      'campaign.starting-count.fundraiser'
    );
    expect(await t.read()).toMatchObject({ startingCount: 0, participants: 0 });
  });

  it('refuses a gift once closed, before any checkout opens', async () => {
    const t = await setup();
    await t.step(useCases.closeCampaign);
    await expectCode(
      t.invoker.run(useCases.submitForm, t.admin, {
        formId: t.campaign().formId!,
        values: { email: 'ans@example.org', amount: '25' },
        locale: 'nl',
        returnUrl: RETURN,
      }),
      'conflict',
      'campaign.closed'
    );
    const { donations } = await t.invoker.run(useCases.listDonations, t.admin, {});
    expect(donations).toEqual([]);
    expect((await t.card()).available && (await t.card())).toMatchObject({ formId: null });
  });
});
