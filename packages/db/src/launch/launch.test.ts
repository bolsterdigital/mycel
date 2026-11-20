// The launch checklist against Postgres (0085, ADR 037): what the memory store cannot prove. The
// state is one upsert per step under forced RLS, so another site neither sees nor changes it; the
// note travels with a tenant export; and reading the list costs the same number of queries for a
// site with one form as for one with several.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  Invoker,
  buildRegistry,
  useCases,
  type LaunchChecklist,
  type Principal,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  principal,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import type { Database } from '../infra/schema.js';
import { readTenant } from '../portability/export.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const step = (list: LaunchChecklist, id: string) =>
  list.phases.flatMap((p) => p.steps).find((s) => s.id === id)!;

describe.skipIf(skip)('launch checklist conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const queries: string[] = [];
  // The app connection with a query log, so a test can count what one read costs.
  const appDb = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: appUrl, max: 4 }) }),
    log: (event) => {
      if (event.level === 'query') queries.push(event.query.sql);
    },
  });
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns({}),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  const tenants: string[] = [];
  let admin: Principal;

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const tenant = (await testTenant(operatorDb, `launch-${run}`)).id;
    tenants.push(tenant);
    admin = principal({ tenantId: tenant });
  });
  afterAll(async () => {
    if (tenants.length) await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('stores one row per step, changes it in place, and exports the note', async () => {
    await invoker.run(useCases.updateLaunchStep, admin, {
      stepId: 'go-no-go',
      note: 'Bestuur, 3 december',
    });
    const list = await invoker.run(useCases.updateLaunchStep, admin, {
      stepId: 'go-no-go',
      done: true,
      owner: 'shared',
    });
    expect(step(list, 'go-no-go')).toMatchObject({
      status: 'done',
      note: 'Bestuur, 3 december',
      owner: 'shared',
    });
    const { rows } = await sql<{ n: string }>`select count(*) as n from launch_steps
      where tenant_id = ${admin.tenantId}`.execute(operatorDb);
    expect(rows[0]!.n).toBe('1');

    const lines: string[] = [];
    await readTenant(operatorDb, admin.tenantId, (table, line) => {
      if (table === 'launch_steps') lines.push(line);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Bestuur, 3 december');
  });

  it('shows another site nothing of this list and lets it change only its own', async () => {
    const other = (await testTenant(operatorDb, `launch-b-${run}`)).id;
    tenants.push(other);
    const elsewhere = principal({ tenantId: other });
    expect(
      step(await invoker.run(useCases.getLaunchChecklist, elsewhere, {}), 'go-no-go')
    ).toMatchObject({ status: 'open', note: '' });
    await invoker.run(useCases.updateLaunchStep, elsewhere, { stepId: 'go-no-go', note: 'ander' });
    const own = await invoker.run(useCases.getLaunchChecklist, admin, {});
    expect(step(own, 'go-no-go').note).toBe('Bestuur, 3 december');
  });

  it('refuses a note the table would not hold, before it reaches the table', async () => {
    await expect(
      invoker.run(useCases.updateLaunchStep, admin, { stepId: 'backup', note: 'x'.repeat(1001) })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('reads the list in the same number of queries for one form as for several', async () => {
    const count = async () => {
      queries.length = 0;
      const list = await invoker.run(useCases.getLaunchChecklist, admin, {});
      return { list, queries: queries.length };
    };
    await invoker.run(useCases.createForm, admin, { kind: 'contact' });
    const one = await count();
    for (let i = 0; i < 3; i++) await invoker.run(useCases.createForm, admin, { kind: 'contact' });
    const four = await count();
    expect(four.queries).toBe(one.queries);
    expect(step(four.list, 'form-notifications')).toMatchObject({ status: 'warn' });
    expect(step(four.list, 'form-notifications').detail?.subjects).toHaveLength(4);
  });
});
