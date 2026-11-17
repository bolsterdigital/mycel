// The order of a payment's ledger (0072, ADR 005 rule 1). One walk writes several entries with the
// same `at`, and an id gives no order either, so the ledger reads in the order of writing. The
// case pins the clock and hands out ids that run backwards: an adapter that sorts on `at` and the
// id reads the history upside down here, by construction rather than by chance. Memory and
// Postgres run the same case against the same record.
// Rejected: a case in `adapter-rules`, whose adapters share one ascending id source with every
// other scenario of the suite.
//
// The Postgres half skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  type Ids,
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
import { createDb, createUnitOfWork, migrate, uuidv7 } from './index.js';
import { closeTenantWork, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

/** Valid UUIDv7s, each a millisecond older than the one before. */
function backwardIds(): Ids {
  let ms = Date.UTC(2030, 0, 1);
  return { next: () => uuidv7(ms--) };
}

const expected = [
  '->created:checkout',
  'created>open:checkout',
  'open>paid:webhook',
  'paid>refunded:webhook',
];

/** A checkout (two entries) and a check that walks two steps, all on one moment. */
async function observe(uow: UnitOfWork, provider: FakePaymentProvider, tenantId: string) {
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(tenantId, 'money-order');
  const { paymentId } = await invoker.run(useCases.createDonation, admin, {
    amount: 2500,
    currency: 'EUR',
    description: 'Donation',
    locale: 'nl',
    returnUrl: 'http://localhost:5173/probe/donation/{token}',
  });
  const { donation } = await invoker.run(useCases.getDonation, admin, { paymentId });
  provider.settle(donation.providerRef, 'refunded');
  await invoker.run(useCases.checkDonation, admin, { paymentId, cause: 'webhook' });
  const { ledger } = await invoker.run(useCases.getDonation, admin, { paymentId });
  return {
    steps: ledger.map((e) => `${e.from ?? '-'}>${e.to}:${e.cause}`),
    moments: new Set(ledger.map((e) => e.at)).size,
  };
}

describe('ledger order, memory', () => {
  it('reads a payment’s entries in the order they were written', async () => {
    const provider = new FakePaymentProvider();
    const uow = new MemoryUnitOfWork({
      clock: new FakeClock(),
      ids: backwardIds(),
      paymentProvider: provider,
    });
    expect(await observe(uow, provider, uuidv7())).toEqual({ steps: expected, moments: 1 });
  });
});

describe.skipIf(skip)('ledger order, postgres', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const provider = new FakePaymentProvider();
  const uow = createUnitOfWork(appDb, {
    paymentProvider: provider,
    clock: new FakeClock(),
    ids: backwardIds(),
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

  it('reads a payment’s entries in the order they were written', async () => {
    const { id } = await testTenant(operatorDb, `money-${runSuffix()}`, { name: 'Money' });
    tenants.push(id);
    expect(await observe(uow, provider, id)).toEqual({ steps: expected, moments: 1 });
  });
});
