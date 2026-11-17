// Reader activity against Postgres (migration 0071, ADR 019 rule 7): what the in-memory store
// cannot prove. `retention.apply` deletes a tenant's `reader.signed_in` events past the term it
// set (90 days by default, 0 keeps none) and nothing else; the policy of 0071 refuses any other
// event type and any sign-in the projection does not hold yet, whatever a statement asks; a late
// event re-folds the compacted log without moving `last_seen_at` back; an erasure clears it; and
// another tenant is not touched. The self-service flow itself is
// packages/core/src/readers/account.test.ts.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  SupporterEvent,
  appendAndFold,
  ingest,
  retentionCutoffs,
  systemPrincipal,
  type SupporterProjection,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { applyErasures, applyRetention, createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { asRole, closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');
const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(skip)('reader activity retention', () => {
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
  const run = runSuffix();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  let a = '';
  let b = '';
  const admin = (tenant: string) => systemPrincipal(tenant, 'test');

  const envelope = (email: string, type: string, at: string, n: string, props = {}) =>
    SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: `${run}-${n}`,
      type,
      email,
      occurred_at: at,
      source: 'test',
      source_site: 'urn:test',
      source_ref: `test:${run}:${n}`,
      props,
    });

  /** A supporter subscribed `days[0]` days ago who signed in on each of `days`. */
  async function reader(tenant: string, email: string, days: number[]) {
    const id = await uow.run(admin(tenant), async (ctx) => {
      await ingest(
        ctx,
        envelope(email, 'newsletter.subscribed', ago(days[0]! + 1), `${email}-sub`, {
          list: 'nieuwsbrief',
          confirmed: true,
        })
      );
      const p = (await ctx.supporters.getProjection(email))!;
      for (const d of days)
        await appendAndFold(ctx, {
          ...envelope(email, 'reader.signed_in', ago(d), `${email}-in-${d}`),
          supporter_id: p.id,
        });
      return p.id;
    });
    return id;
  }
  const projection = (tenant: string, email: string) =>
    uow.run(admin(tenant), (ctx) => ctx.supporters.getProjection(email));
  const types = (tenant: string, supporterId: string) =>
    uow.run(admin(tenant), async (ctx) =>
      (await ctx.supporters.eventsFor(supporterId)).map((e) => e.type)
    );
  const cutoffs = (readerActivityDays: number) =>
    retentionCutoffs(now, { submissionMonths: 24, readerActivityDays });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    // The fixtures reach 41 days back: those months need their partition, never events_default.
    await sql`select ensure_event_partitions(${ago(45)}::date, ${now.toISOString()}::date)`.execute(
      operatorDb
    );
    a = (await testTenant(operatorDb, `act-a-${run}`)).id;
    b = (await testTenant(operatorDb, `act-b-${run}`)).id;
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [a, b]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('deletes sign-ins past the term and keeps the last one in the projection', async () => {
    const email = `term-${run}@example.org`;
    const id = await reader(a, email, [40, 20, 1]);
    const other = await reader(b, email, [40]);
    const before = (await projection(a, email))!;
    expect(before.lastSeenAt).toBe(ago(1));

    // 30 days: the sign-in of 40 days ago goes, the subscription of 41 days ago stays.
    expect(await applyRetention(operatorDb, a, cutoffs(30))).toMatchObject({ readerActivity: 1 });
    expect(await types(a, id)).toEqual([
      'newsletter.subscribed',
      'reader.signed_in',
      'reader.signed_in',
    ]);
    // 0 days: only the projection is left of the activity.
    expect(await applyRetention(operatorDb, a, cutoffs(0))).toMatchObject({ readerActivity: 2 });
    expect(await types(a, id)).toEqual(['newsletter.subscribed']);
    const after = (await projection(a, email))!;
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.lists).toEqual(['nieuwsbrief']);
    // A second run finds nothing; the other tenant kept its events.
    expect(await applyRetention(operatorDb, a, cutoffs(0))).toMatchObject({ readerActivity: 0 });
    expect(await types(b, other)).toEqual(['newsletter.subscribed', 'reader.signed_in']);
  });

  it('keeps the last sign-in when a late event re-folds the compacted log', async () => {
    const email = `late-${run}@example.org`;
    await reader(a, email, [10, 2]);
    const before = (await projection(a, email))!;
    await applyRetention(operatorDb, a, cutoffs(0));
    await uow.run(admin(a), (ctx) =>
      ingest(
        ctx,
        envelope(email, 'newsletter.subscribed', ago(5), `${email}-late`, {
          list: 'acties',
          confirmed: true,
        })
      )
    );
    const after = (await projection(a, email))! as SupporterProjection;
    expect(after.lists).toEqual(['acties', 'nieuwsbrief']);
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.firstSeen).toBe(before.firstSeen);
    expect(after.lastActivity).toBe(before.lastActivity);
  });

  it('holds its floor: no other event type, no sign-in the projection does not hold', async () => {
    const email = `floor-${run}@example.org`;
    const id = await reader(a, email, [30]);
    // As if the fold had not run yet: the projection does not hold the sign-in.
    await sql`update supporters set last_seen_at = null where tenant_id = ${a} and id = ${id}`.execute(
      operatorDb
    );
    expect(await applyRetention(operatorDb, a, cutoffs(0))).toMatchObject({ readerActivity: 0 });
    // A statement that asks for every event of the tenant still deletes none of these.
    const gone = await asRole(operatorDb, 'mycel_retention', async (trx) => {
      await sql`select set_config('app.tenant_id', ${a}, true)`.execute(trx);
      return sql`delete from events where supporter_id = ${id}`.execute(trx);
    });
    expect(Number(gone.numAffectedRows ?? 0n)).toBe(0);
    expect(await types(a, id)).toEqual(['newsletter.subscribed', 'reader.signed_in']);
  });

  it('clears the last sign-in with an erasure', async () => {
    const email = `erase-${run}@example.org`;
    const id = await reader(a, email, [3]);
    await uow.run(admin(a), (ctx) => ctx.erasures.register(id, email));
    expect(await applyErasures(operatorDb, a)).toBeGreaterThan(0);
    const row = await sql<{ last_seen_at: Date | null }>`
      select last_seen_at from supporters where tenant_id = ${a} and id = ${id}`.execute(
      operatorDb
    );
    expect(row.rows[0]!.last_seen_at).toBeNull();
    expect(await applyErasures(operatorDb, a)).toBe(0);
  });
});
