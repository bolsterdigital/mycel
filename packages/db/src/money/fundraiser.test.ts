// A fundraiser's counter over both adapters (0075, ADR 033 rule 8): gifts through the bound
// donation form name the campaign; the counter sums the paid ones in the tenant currency, drops a
// refund, ignores a gift outside the campaign and an open checkout, and keeps an erased donor's
// money. Memory and Postgres run the same case against the same record.
//
// The Postgres half skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases, type UnitOfWork } from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakePaymentProvider,
  FakeSigner,
  MemoryUnitOfWork,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { applyErasures, createDb, createUnitOfWork, migrate, uuidv7 } from '../index.js';
import { closeTenantWork, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const RETURN = 'http://localhost:5173/probe/donation/{token}';

async function observe(
  uow: UnitOfWork,
  provider: FakePaymentProvider,
  clock: FakeClock,
  tenantId: string,
  erase: (tenantId: string) => Promise<unknown>
) {
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(tenantId, 'fundraiser');
  let campaign = await invoker.run(useCases.composeCampaign, admin, {
    kind: 'fundraiser',
    title: { nl: 'Geef' },
    defaultLocale: 'nl',
    locales: ['nl'],
    goal: { target: 100_000, milestones: [] },
  });
  const { item } = await invoker.run(useCases.getItem, admin, {
    itemId: campaign.landingItemId,
  });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: item.latestRevisionId,
    locale: 'nl',
  });
  campaign = await invoker.run(useCases.openCampaign, admin, {
    campaignId: campaign.id,
    baseUpdatedAt: campaign.updatedAt,
  });
  const loose = await invoker.run(useCases.createForm, admin, { kind: 'donation' });
  const give = async (email: string, amount: string, formId = campaign.formId!) => {
    const result = await invoker.run(useCases.submitForm, admin, {
      formId,
      values: { email, amount },
      locale: 'nl',
      returnUrl: RETURN,
    });
    if (result.status !== 'accepted') throw new Error(`not accepted: ${result.status}`);
    clock.advance(1000);
    const { donations } = await invoker.run(useCases.listDonations, admin, {});
    return donations.find((d) => d.submissionId === result.submissionId)!;
  };
  const settle = (p: { id: string; providerRef: string }, outcome: 'paid' | 'refunded') => {
    provider.settle(p.providerRef, outcome);
    return invoker.run(useCases.checkDonation, admin, { paymentId: p.id, cause: 'webhook' });
  };
  const counter = async () => {
    const view = await invoker.run(useCases.getCampaign, admin, { campaignId: campaign.id });
    return { participants: view.participants, raised: view.raised };
  };

  const kept = await give('blijft@example.org', '50');
  const refunded = await give('terug@example.org', '25');
  const erased = await give('weg@example.org', '10');
  await give('open@example.org', '25');
  const outside = await give('elders@example.org', '50', loose.id);
  for (const p of [kept, refunded, erased, outside]) await settle(p, 'paid');
  const paid = await counter();
  await settle(refunded, 'refunded');
  const afterRefund = await counter();

  const leaving = await invoker.run(useCases.getSupporter, admin, { email: 'weg@example.org' });
  await uow.run(admin, (ctx) => ctx.erasures.register(leaving.id, leaving.email));
  await erase(tenantId);
  const gone = await invoker.run(useCases.getDonation, admin, { paymentId: erased.id });

  return {
    named: [kept, refunded, erased, outside].map((p) => p.campaignId === campaign.id),
    paid,
    afterRefund,
    erasedPayment: {
      supporterId: gone.donation.supporterId,
      named: gone.donation.campaignId === campaign.id,
    },
    afterErasure: await counter(),
  };
}

const expected = {
  named: [true, true, true, false],
  paid: { participants: 3, raised: { amount: 8500, currency: 'EUR' } },
  afterRefund: { participants: 2, raised: { amount: 6000, currency: 'EUR' } },
  erasedPayment: { supporterId: null, named: true },
  afterErasure: { participants: 2, raised: { amount: 6000, currency: 'EUR' } },
};

describe('fundraiser counter, memory', () => {
  it('sums the paid gifts given through the bound form', async () => {
    const provider = new FakePaymentProvider();
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
    const tenantId = '01900000-0000-7000-8000-0000000d0f02';
    const erase = (t: string) =>
      uow.run(systemPrincipal(t, 'erasures'), (ctx) => ctx.erasures.apply());
    expect(await observe(uow, provider, clock, tenantId, erase)).toEqual(expected);
  });
});

describe.skipIf(skip)('fundraiser counter, postgres', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const provider = new FakePaymentProvider();
  const clock = new FakeClock();
  const uow = createUnitOfWork(appDb, {
    paymentProvider: provider,
    clock,
    ids: { next: () => uuidv7() },
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    connectionCredentialKey: '21'.repeat(32),
  });
  const tenants: string[] = [];

  beforeAll(() => migrate(operatorUrl, { log: () => {} }));
  afterAll(async () => {
    await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('sums the paid gifts given through the bound form', async () => {
    const { id } = await testTenant(operatorDb, `fundraiser-${runSuffix()}`, {
      name: 'Fundraiser',
    });
    tenants.push(id);
    const erase = (t: string) => applyErasures(operatorDb, t);
    expect(await observe(uow, provider, clock, id, erase)).toEqual(expected);
  });
});
