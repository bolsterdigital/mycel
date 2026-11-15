// Presence against Postgres (ADR 029): what the memory store cannot prove. A beat upserts one row
// per actor, item and tab; RLS keeps a report inside its site; the janitor sweeps across tenants;
// no audit row and no export row is written.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Invoker, buildRegistry, systemPrincipal, useCases, type Principal } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  principal,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, sweepRateLimits, uuidv7, uuidv7Ids } from './index.js';
import { asRole } from './infra/roles.js';
import { TABLES } from './portability/export.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('content presence over Postgres (ADR 029)', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns({}),
    platform: memoryPlatform,
    connectionCredentialKey: '10'.repeat(32),
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  let tenant = '';
  let other = '';
  let itemId = '';
  const person = (name: string, tenantId = tenant): Principal =>
    principal({
      tenantId,
      capabilities: ['content:read', 'content:write'],
      actor: { kind: 'operator', operatorId: `${name}-${run}` },
    });

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenant = (await testTenant(operatorDb, `presence-${run}`)).id;
    other = (await testTenant(operatorDb, `presence-o-${run}`)).id;
    const made = await invoker.run(useCases.createItem, systemPrincipal(tenant, 't'), {
      ...useCases.createItem.examples[0].input,
      slug: `presence-${run}`,
    });
    itemId = made.item.id;
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenant, other]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  const beat = (who: Principal, sessionId: string, state: 'viewing' | 'editing') =>
    invoker.run(useCases.updatePresence, who, { itemId, sessionId, state });

  it('keeps one row per tab, and a later beat replaces it', async () => {
    const tab = uuidv7();
    await beat(person('anna'), tab, 'viewing');
    await beat(person('anna'), tab, 'editing');
    const seen = await invoker.run(useCases.listPresence, person('ben'), { itemId });
    expect(seen.present).toEqual([{ actor: person('anna').actor, state: 'editing', self: false }]);
  });

  it('does not let one actor overwrite the row of another with the same session id', async () => {
    const shared = uuidv7();
    await beat(person('carol'), shared, 'editing');
    await beat(person('dan'), shared, 'viewing');
    const { present } = await invoker.run(useCases.listPresence, person('erin'), { itemId });
    const states = Object.fromEntries(
      present.map((p) => [p.actor.kind === 'operator' ? p.actor.operatorId : '', p.state])
    );
    expect(states[`carol-${run}`]).toBe('editing');
    expect(states[`dan-${run}`]).toBe('viewing');
  });

  it('keeps a report inside its site: another tenant gets not-found and reads no row', async () => {
    const outsider = person('frank', other);
    await expect(invoker.run(useCases.listPresence, outsider, { itemId })).rejects.toMatchObject({
      code: 'not_found',
    });
    const read = await uow.run(outsider, (ctx) => ctx.presence.active(itemId, new Date(0)));
    expect(read).toEqual([]);
  });

  it('refuses a mycel_app delete: only the janitor sweeps', async () => {
    await expect(
      asRole(operatorDb, 'mycel_app', (trx) => sql`delete from content_presence`.execute(trx))
    ).rejects.toThrow(/permission denied/);
  });

  it('is swept by the janitor once nobody reads it, across tenants, not while it is fresh', async () => {
    const stale = uuidv7();
    const fresh = uuidv7();
    await beat(person('gina'), stale, 'editing');
    await beat(person('gina'), fresh, 'editing');
    await sql`update content_presence set last_seen_at = now() - interval '11 minutes'
      where session_id = ${stale}`.execute(operatorDb);
    await sweepRateLimits(operatorDb);
    const left = await sql<{ session_id: string }>`select session_id from content_presence
      where tenant_id = ${tenant} and session_id in (${stale}, ${fresh})`.execute(operatorDb);
    expect(left.rows.map((r) => r.session_id)).toEqual([fresh]);
  });

  it('writes no audit row and is not part of an export', async () => {
    await beat(person('hana'), uuidv7(), 'viewing');
    const audit = await sql<{ n: string }>`select count(*) as n from audit_log
      where tenant_id = ${tenant} and operation like 'content.presence.%'`.execute(operatorDb);
    expect(audit.rows[0]?.n).toBe('0');
    expect(TABLES.content_presence).toBe('operational');
  });
});
