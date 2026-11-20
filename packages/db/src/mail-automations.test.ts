// Welcome series against Postgres (migration 0082, MY-258). The memory suite (core
// `mailing/automation.test.ts`) proves who gets which step when; this one proves what only the
// database can: a series is one per list, saving replaces its steps, a run starts once per
// person even when two workers start it together, `advance` lets one of two runs of a step job
// through, and the application role cannot rename a series' list.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  adminOf,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7, uuidv7Ids, withTenant } from './index.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('mail automations over Postgres', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    connectionCredentialKey: 'ab'.repeat(32),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    emailRenderer: { render: () => ({ html: '<p></p>', text: '' }) },
  });
  const run = runSuffix();
  let tenantId = '';
  const as = <T>(fn: Parameters<typeof uow.run<T>>[1]) => uow.run(adminOf(tenantId), fn);
  const series = (id: string, delays: number[], enabled = true) => ({
    id,
    list: 'newsletter',
    enabled,
    steps: delays.map((delayDays) => ({ itemId: uuidv7(), delayDays })),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenantId = (await testTenant(operatorDb, `automations-${run}`, { name: 'A' })).id;
  });
  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenantId]);
    await appDb.destroy();
    await operatorDb.destroy();
  });

  it('keeps one series per list and replaces its steps on save', async () => {
    const id = uuidv7();
    await as((ctx) => ctx.mailAutomations.save(series(id, [0, 2, 7])));
    await as((ctx) => ctx.mailAutomations.save(series(id, [1], false)));
    const saved = await as((ctx) => ctx.mailAutomations.forList('newsletter'));
    expect(saved).toMatchObject({ id, enabled: false, steps: [{ delayDays: 1 }] });
    await expect(as((ctx) => ctx.mailAutomations.save(series(uuidv7(), [0])))).rejects.toThrow();
  });

  it('starts a run once, lets one of two step runs advance, and counts who got how far', async () => {
    const id = (await as((ctx) => ctx.mailAutomations.forList('newsletter')))!.id;
    await as((ctx) => ctx.mailAutomations.save(series(id, [0, 3])));
    const [ada, bob] = [uuidv7(), uuidv7()];
    const starts = await Promise.all([
      as((ctx) => ctx.mailAutomations.start(id, ada, new Date())),
      as((ctx) => ctx.mailAutomations.start(id, ada, new Date())),
    ]);
    expect(starts.sort()).toEqual([false, true]);
    await as((ctx) => ctx.mailAutomations.start(id, bob, new Date()));

    const advances = await Promise.all([
      as((ctx) => ctx.mailAutomations.advance(id, ada, 0)),
      as((ctx) => ctx.mailAutomations.advance(id, ada, 0)),
    ]);
    expect(advances.sort()).toEqual([false, true]);
    await as((ctx) => ctx.mailAutomations.advance(id, ada, 1));
    await as((ctx) => ctx.mailAutomations.advance(id, bob, 0));
    expect(await as((ctx) => ctx.mailAutomations.run(id, ada))).toMatchObject({ through: 1 });
    expect(await as((ctx) => ctx.mailAutomations.reach(id))).toEqual({
      started: 2,
      reached: [2, 1],
    });
  });

  it('keeps the list of a series out of reach of the application role', async () => {
    const id = (await as((ctx) => ctx.mailAutomations.forList('newsletter')))!.id;
    await expect(
      withTenant(appDb, adminOf(tenantId), (trx) =>
        sql`update mail_automations set list = 'other' where id = ${id}`.execute(trx)
      )
    ).rejects.toThrow(/permission denied/);
  });
});
