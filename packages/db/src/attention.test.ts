// The attention use cases against Postgres: what the memory store cannot prove. The
// worker stamps `failed_at` (0034), the read state lives on the member's own row and only moves
// forward, `ConnectionIntents.recent` reads every connection's newest intents in one statement,
// the bell's count costs the same number of queries for one connection as for many, and a tenant
// export does not carry a member's read state.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import {
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  type ConnectionIntent,
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
import { claimJobs, createDb, createUnitOfWork, failJob, uuidv7, uuidv7Ids } from './index.js';
import type { Database } from './infra/schema.js';
import { readTenant } from './portability/export.js';
import { asRole } from './infra/roles.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const connectionInput = (purpose: string) => ({
  provider: 'webhook' as const,
  accountRef: null,
  externalOwner: 'Example organisation',
  maintainer: 'Maintainer',
  purpose,
  direction: 'outbound' as const,
  dataAuthority: 'mycel' as const,
  consentAuthority: 'mycel' as const,
  consentScopes: ['newsletter:main'],
  formIds: [],
  destination: 'https://hooks.example.org/mycel',
  contractVersion: 'v1',
  adapterVersion: 'v1',
});

describe.skipIf(skip)('attention conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const queries: string[] = [];
  // The app connection with a query log, so a test can count what one call costs.
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
    dns: new FakeDns({ 'hooks.example.org': ['8.8.8.8'] }),
    platform: memoryPlatform,
    connectionCredentialKey: '10'.repeat(32),
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  let tenant = '';
  let admin: Principal;

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenant = (await testTenant(operatorDb, `attention-${run}`)).id;
    const invited = await invoker.run(useCases.inviteMember, systemPrincipal(tenant, 't'), {
      email: `admin-${run}@example.org`,
      capabilities: ['tenant:admin'],
    });
    admin = principal({
      tenantId: tenant,
      actor: {
        kind: 'operator',
        operatorId: invited.operatorId,
        email: `admin-${run}@example.org`,
      },
    });
  });
  afterAll(async () => {
    if (tenant) await closeTenantWork(operatorDb, [tenant]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('dates an exhausted job from the failure the worker stamped', async () => {
    const type = `attention.probe.${run}`;
    await asRole(operatorDb, 'mycel_worker', (trx) =>
      trx
        .insertInto('jobs')
        .values({
          id: uuidv7(),
          tenant_id: tenant,
          type,
          key: `${type}:1`,
          run_at: new Date(Date.now() - 1000),
          payload: '{}',
          max_attempts: 1,
        })
        .execute()
    );
    const [claimed] = await claimJobs(operatorDb, { types: [type] });
    expect(claimed?.failedAt).toBeNull();
    await failJob(operatorDb, claimed!, 'gave up');
    const { items } = await invoker.run(useCases.listAttention, admin, {});
    const item = items.find((i) => i.detail === type);
    expect(item).toMatchObject({ source: 'job', subjectId: claimed!.id, unread: true });
    const { rows } = await sql<{ failed_at: Date }>`select failed_at from jobs
      where id = ${claimed!.id}`.execute(operatorDb);
    expect(item?.since).toBe(rows[0]!.failed_at.toISOString());
  });

  it('keeps the read state on the member row, forward only, and out of the export', async () => {
    const later = new Date(Date.now() - 1000);
    const earlier = new Date(later.getTime() - 60_000);
    await expect(
      invoker.run(useCases.updateAttentionSeenAt, admin, { at: later.toISOString() })
    ).resolves.toEqual({ seenAt: later.toISOString() });
    await expect(
      invoker.run(useCases.updateAttentionSeenAt, admin, { at: earlier.toISOString() })
    ).resolves.toEqual({ seenAt: later.toISOString() });
    expect((await invoker.run(useCases.getAttentionSummary, admin, {})).seenAt).toBe(
      later.toISOString()
    );
    const lines: string[] = [];
    await readTenant(operatorDb, tenant, (table, line) => {
      if (table === 'tenant_memberships') lines.push(line);
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('attention_seen_at');
    const stored = await sql<{ at: Date | null }>`select attention_seen_at as at
      from tenant_memberships where tenant_id = ${tenant}`.execute(operatorDb);
    expect(stored.rows[0]!.at).toEqual(later);
  });

  it('cannot mark another site read: the member row is found under its own tenant only', async () => {
    const other = (await testTenant(operatorDb, `attention-b-${run}`)).id;
    try {
      const elsewhere = principal({ tenantId: other, actor: admin.actor });
      await expect(
        invoker.run(useCases.updateAttentionSeenAt, elsewhere, { at: new Date().toISOString() })
      ).rejects.toMatchObject({ code: 'not_found' });
      const { rows } = await sql<{ n: string }>`select count(*) as n from tenant_memberships
        where tenant_id = ${other}`.execute(operatorDb);
      expect(rows[0]!.n).toBe('0');
    } finally {
      await closeTenantWork(operatorDb, [other]);
    }
  });

  it('counts the bell in the same number of queries for one connection as for three', async () => {
    const intentFor = (connectionId: string, state: ConnectionIntent['state']) =>
      uow.run(admin, (ctx) => {
        const now = new Date();
        const id = uuidv7();
        return ctx.connectionIntents.insert({
          id,
          connectionId,
          businessId: id,
          connectionVersion: 1,
          credentialVersion: 1,
          source: 'test',
          mappingVersion: 'v1',
          supporterId: null,
          scope: 'newsletter:main',
          actor: { kind: 'system', id: 'test' },
          key: id,
          state,
          failure: state === 'failed' ? 'exhausted' : null,
          attempts: 1,
          revision: 0,
          leaseToken: null,
          leaseUntil: null,
          nextAt: now,
          createdAt: now,
          updatedAt: now,
        });
      });
    const count = async () => {
      queries.length = 0;
      const summary = await invoker.run(useCases.getAttentionSummary, admin, {});
      return { summary, queries: queries.length };
    };

    const first = await invoker.run(useCases.createConnection, admin, connectionInput('one'));
    // A new connection is paused, so only an unknown outcome asks for attention.
    await intentFor(first.id, 'unknown');
    const one = await count();
    for (const purpose of ['two', 'three']) {
      const c = await invoker.run(useCases.createConnection, admin, connectionInput(purpose));
      await intentFor(c.id, 'unknown');
    }
    const three = await count();

    const bySource = (s: typeof one.summary, source: string) =>
      s.sources.find((x) => x.source === source)?.total;
    expect(bySource(one.summary, 'connection')).toBe(1);
    expect(bySource(three.summary, 'connection')).toBe(3);
    expect(three.queries).toBe(one.queries);
  });
});
