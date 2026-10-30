// Supporter consistency against Postgres (ADR 019 rules 1 to 3, ADR 003 consequence 1): the
// per-address lock serialises concurrent ingests, late events re-fold, dedup survives
// partitioning, and nothing lands in the default partition. The memory adapter cannot prove any
// of this; packages/core/src/supporters/service.test.ts covers the fold itself.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  SupporterEvent,
  buildRegistry,
  ingest,
  rebuildProjection,
  systemPrincipal,
  useCases,
  type SupporterEventType,
} from '@mycel/core';
import {
  FakeInputHasher,
  FakeSigner,
  FakeDns,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from './index.js';
import { requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('supporter conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  const base = Date.now() - 10 * 60_000;
  let admin = systemPrincipal('', 'test');

  const event = (
    email: string,
    ref: string,
    type: SupporterEventType,
    minute: number,
    props: Record<string, unknown> = {}
  ) =>
    SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: `${run}-${ref}`,
      type,
      email,
      occurred_at: new Date(base + minute * 60_000).toISOString(),
      source: 'test',
      source_site: 'urn:mycel:test',
      source_ref: ref,
      props,
    });
  const ingestOne = (e: SupporterEvent) => uow.run(admin, (ctx) => ingest(ctx, e));
  const projection = (email: string) =>
    uow.run(admin, (ctx) => ctx.supporters.getProjection(email));
  const log = (supporterId: string) =>
    uow.run(admin, (ctx) => ctx.supporters.eventsFor(supporterId));

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const tenant = await testTenant(operatorDb, `sup-${run}`, { name: 'Supporters' });
    admin = systemPrincipal(tenant.id, 'test');
  });

  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('serialises parallel ingests for one new supporter into the serial fold', async () => {
    const email = `par-${run}@example.org`;
    const events = ['a', 'b', 'c', 'd'].map((list, i) =>
      event(email, `par-${list}`, 'newsletter.subscribed', 4 - i, { list })
    );
    // The same event twice in the batch: under the lock exactly one append wins.
    const results = await Promise.all([...events, events[0]!].map(ingestOne));
    expect(results.filter(Boolean)).toHaveLength(4);

    const stored = await projection(email);
    const events_ = await log(stored!.id);
    expect(events_).toHaveLength(4);
    expect(new Set(events_.map((e) => e.supporter_id))).toEqual(new Set([stored!.id]));
    expect(stored).toEqual(rebuildProjection(events_));
    expect(stored?.lists).toEqual(['a', 'b', 'c', 'd']);
  });

  it('serialises parallel ingests for an existing supporter without a lost update', async () => {
    // ADR 019 rule 3: the new-supporter race above is also caught by the unique constraint on
    // (tenant_id, email); only this variant proves the lock. Without lock() every writer reads
    // the same appliedThrough, applies its own event on top and the last save wins (5/5 runs).
    const email = `par2-${run}@example.org`;
    await ingestOne(event(email, 'par2-seed', 'newsletter.subscribed', 1, { list: 'seed' }));
    const events = ['a', 'b', 'c', 'd'].map((list, i) =>
      event(email, `par2-${list}`, 'newsletter.subscribed', 5 - i, { list })
    );
    const results = await Promise.all(events.map(ingestOne));
    expect(results.filter(Boolean)).toHaveLength(4);

    const stored = await projection(email);
    const events_ = await log(stored!.id);
    expect(events_).toHaveLength(5);
    expect(stored).toEqual(rebuildProjection(events_));
    expect(stored?.lists).toEqual(['a', 'b', 'c', 'd', 'seed']);
  });

  it('leaves a supporter unsubscribed when an older subscribe arrives late (ADR 019 rule 2)', async () => {
    const email = `late-${run}@example.org`;
    await ingestOne(event(email, 'late-unsub', 'newsletter.unsubscribed', 2, { list: 'news' }));
    await ingestOne(event(email, 'late-sub', 'newsletter.subscribed', 1, { list: 'news' }));
    const stored = await projection(email);
    expect(stored?.lists).toEqual([]);
    expect(stored?.appliedThrough.id).toBe(`${run}-late-unsub`);
    expect(stored).toEqual(rebuildProjection(await log(stored!.id)));
  });

  it('keeps a later subscribe when an older unsubscribe arrives late', async () => {
    const email = `late2-${run}@example.org`;
    await ingestOne(event(email, 'late2-sub', 'newsletter.subscribed', 2, { list: 'news' }));
    await ingestOne(event(email, 'late2-unsub', 'newsletter.unsubscribed', 1, { list: 'news' }));
    expect((await projection(email))?.lists).toEqual(['news']);
  });

  it('changes an address under both locks and refuses one that is taken', async () => {
    const email = `move-${run}@example.org`;
    const taken = `taken-${run}@example.org`;
    await ingestOne(event(email, 'move-sub', 'newsletter.subscribed', 1, { list: 'news' }));
    await ingestOne(event(taken, 'taken-sub', 'newsletter.subscribed', 1, { list: 'news' }));
    const { id } = (await projection(email))!;

    await expect(
      invoker.run(useCases.changeSupporterEmail, admin, {
        supporterId: id,
        newEmail: taken,
        reason: 'test',
      })
    ).rejects.toMatchObject({ code: 'conflict' });

    const target = `moved-${run}@example.org`;
    const after = await invoker.run(useCases.changeSupporterEmail, admin, {
      supporterId: id,
      newEmail: target,
      reason: 'test',
    });
    expect(after).toMatchObject({ id, email: target, lists: ['news'] });
    expect(await projection(email)).toBeNull();
    expect(after).toEqual(rebuildProjection(await log(id)));
  });

  it('keeps events_default empty after every fixture', async () => {
    // As the operator: the partition has no RLS of its own, so the owner sees every tenant.
    const { rows } = await sql<{ n: string }>`select count(*) as n from events_default`.execute(
      operatorDb
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});
