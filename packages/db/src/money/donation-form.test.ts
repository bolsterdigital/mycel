// The donation form over both adapters (0074, brief MY-252 PR 2): a submission of a `donation`
// form opens a payment that names it; settling makes its address a supporter through the ingest
// and the payment then names that supporter; the reconciliation finds what stayed open; an
// erasure of the donor clears both references and keeps the payment. Memory and Postgres run
// the same case against the same record. Only Postgres rolls back, so the case of a provider
// that does not answer (no submission is left behind) runs there alone.
// Rejected: a case in `adapter-rules`, which is at its size ceiling.
//
// The Postgres half skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Invoker,
  buildRegistry,
  dueDonations,
  systemPrincipal,
  useCases,
  type UnitOfWork,
} from '@mycel/core';
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

const RETURN = 'https://probe.example/donation/{token}';

async function observe(
  uow: UnitOfWork,
  provider: FakePaymentProvider,
  clock: FakeClock,
  tenantId: string,
  erase: (tenantId: string) => Promise<unknown>
) {
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(tenantId, 'donation-form');
  const form = await invoker.run(useCases.createForm, admin, { kind: 'donation' });
  const give = (email: string, values: Record<string, string>) =>
    invoker.run(useCases.submitForm, admin, {
      formId: form.id,
      values: { email, ...values },
      locale: 'nl',
      returnUrl: RETURN,
    });
  const kept = await give('blijft@example.org', { amount: '25' });
  clock.advance(1000);
  const erased = await give('weg@example.org', { amount: '10', 'amount-other': '12.50' });
  clock.advance(1000);
  const open = await give('later@example.org', { amount: '50' });
  if (kept.status !== 'accepted' || erased.status !== 'accepted' || open.status !== 'accepted')
    throw new Error('not accepted');
  const payments = async () => (await invoker.run(useCases.listDonations, admin, {})).donations;
  const byAmount = async (amount: number) => (await payments()).find((p) => p.amount === amount)!;

  const started = (await payments()).map((p) => ({
    amount: p.amount,
    status: p.status,
    named: p.submissionId !== null,
    supporter: p.supporterId,
  }));
  for (const amount of [2500, 1250]) {
    const p = await byAmount(amount);
    provider.settle(p.providerRef, 'paid');
  }
  await invoker.run(useCases.checkDonation, admin, { token: kept.token!, cause: 'return' });
  await invoker.run(useCases.checkDonation, admin, { token: erased.token!, cause: 'return' });
  const donor = await invoker.run(useCases.getSupporter, admin, { email: 'blijft@example.org' });
  const leaving = await invoker.run(useCases.getSupporter, admin, { email: 'weg@example.org' });
  const settled = await byAmount(2500);
  const events = await uow.run(admin, async (ctx) =>
    (await ctx.supporters.eventsFor(donor.id)).map((e) => `${e.type} ${String(e.props['amount'])}`)
  );

  clock.advance(16 * 60 * 1000);
  const due = await uow.run(admin, (ctx) => dueDonations(ctx));

  await uow.run(admin, (ctx) => ctx.erasures.register(leaving.id, leaving.email));
  await erase(tenantId);
  const afterErasure = await byAmount(1250);

  return {
    started,
    settled: { status: settled.status, isDonor: settled.supporterId === donor.id },
    events,
    due: await Promise.all(
      due.map(async (id) => (await payments()).find((p) => p.id === id)!.amount)
    ),
    erased: {
      status: afterErasure.status,
      supporterId: afterErasure.supporterId,
      submissionId: afterErasure.submissionId,
    },
  };
}

const expected = {
  started: [
    { amount: 5000, status: 'open', named: true, supporter: null },
    { amount: 1250, status: 'open', named: true, supporter: null },
    { amount: 2500, status: 'open', named: true, supporter: null },
  ],
  settled: { status: 'paid', isDonor: true },
  events: ['donation.payment.succeeded 2500'],
  due: [5000],
  erased: { status: 'paid', supporterId: null, submissionId: null },
};

describe('donation form, memory', () => {
  it('opens the payment from the submission and makes the donor a supporter when it settles', async () => {
    const provider = new FakePaymentProvider();
    const clock = new FakeClock();
    const uow = new MemoryUnitOfWork({ clock, paymentProvider: provider });
    const tenantId = '01900000-0000-7000-8000-0000000d0f01';
    const erase = (t: string) =>
      uow.run(systemPrincipal(t, 'erasures'), (ctx) => ctx.erasures.apply());
    expect(await observe(uow, provider, clock, tenantId, erase)).toEqual(expected);
  });
});

describe.skipIf(skip)('donation form, postgres', () => {
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
  const tenant = async () => {
    const { id } = await testTenant(operatorDb, `donation-form-${runSuffix()}`, {
      name: 'Donation form',
    });
    tenants.push(id);
    return id;
  };

  beforeAll(() => migrate(operatorUrl, { log: () => {} }));
  afterAll(async () => {
    await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('opens the payment from the submission and makes the donor a supporter when it settles', async () => {
    const erase = (t: string) => applyErasures(operatorDb, t);
    expect(await observe(uow, provider, clock, await tenant(), erase)).toEqual(expected);
  });

  it('leaves no submission behind when the provider does not open a checkout', async () => {
    const tenantId = await tenant();
    const invoker = new Invoker(buildRegistry(), uow);
    const admin = systemPrincipal(tenantId, 'donation-form');
    const form = await invoker.run(useCases.createForm, admin, { kind: 'donation' });
    provider.failNext();
    await expect(
      invoker.run(useCases.submitForm, admin, {
        formId: form.id,
        values: { email: 'storing@example.org', amount: '10' },
        locale: 'nl',
        returnUrl: RETURN,
      })
    ).rejects.toMatchObject({ code: 'conflict' });
    const stored = await uow.run(admin, (ctx) => ctx.submissions.list(form.id));
    expect(stored).toEqual([]);
    expect((await invoker.run(useCases.listDonations, admin, {})).donations).toEqual([]);
  });
});
