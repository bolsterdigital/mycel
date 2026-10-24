// Real RLS and encryption, beyond the in-memory core test: tenant B must not see A's metadata
// or encrypted credential, and an export must not carry credential ciphertext.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  planConnectionIntent,
  runConnectionIntent,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  FakeClock,
  FakeConnectionTransport,
} from '@mycel/core/testing';
import {
  createDb,
  createUnitOfWork,
  credentialKey,
  decryptCredential,
  encryptCredential,
  migrate,
  TABLES,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
  applyErasures,
  withTenant,
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but database URLs are unset');

import { closeTenantWork } from './testing.js';

const key = '10'.repeat(32);
const input = {
  provider: 'webhook' as const,
  accountRef: null,
  externalOwner: 'Example organisation',
  maintainer: 'Maintainer',
  purpose: 'Newsletter',
  direction: 'outbound' as const,
  dataAuthority: 'mycel' as const,
  consentAuthority: 'mycel' as const,
  consentScopes: ['newsletter:main'],
  formIds: [],
  destination: 'https://hooks.example.org/mycel',
  contractVersion: 'v1',
  adapterVersion: 'v1',
};

it('authenticates credential ciphertext to tenant, connection and version', () => {
  const cipher = encryptCredential('test-token', credentialKey(key), 'tenant-a', 'connection-a', 2);
  expect(cipher).not.toContain('test-token');
  expect(decryptCredential(cipher, credentialKey(key), 'tenant-a', 'connection-a', 2)).toBe(
    'test-token'
  );
  expect(() =>
    decryptCredential(cipher, credentialKey(key), 'tenant-b', 'connection-a', 2)
  ).toThrow();
  expect(() =>
    decryptCredential(cipher, credentialKey(key), 'tenant-a', 'connection-a', 3)
  ).toThrow();
  expect(TABLES.connections).toBe('export');
  expect(TABLES.connection_credentials).toBe('operational');
});

describe.skipIf(!operatorUrl || !appUrl)('managed connection storage', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const clock = new FakeClock(new Date());
  const uow = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    connectionCredentialKey: key,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const suffix = Math.random().toString(36).slice(2, 8);
  let a = '';
  let b = '';

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const tenant = async (slug: string) =>
      (
        await upsertTenant(
          operatorDb,
          {
            id: uuidv7(),
            slug,
            name: slug,
            defaultLocale: 'nl',
            locales: ['nl'],
          },
          { platformDomain: 'localhost' }
        )
      ).id;
    a = await tenant(`connections-a-${suffix}`);
    b = await tenant(`connections-b-${suffix}`);
  });
  afterAll(async () => {
    if (a) await closeTenantWork(operatorDb, [a]);
    if (b) await closeTenantWork(operatorDb, [b]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('keeps metadata and ciphertext within A, and the secret out of reads and audit', async () => {
    const pa = systemPrincipal(a, 'test');
    const pb = systemPrincipal(b, 'test');
    const created = await invoker.run(useCases.createConnection, pa, input);
    const replaced = await invoker.run(useCases.replaceConnectionCredential, pa, {
      id: created.id,
      baseVersion: created.version,
      secret: 'private-connector-token',
    });
    expect(replaced).toMatchObject({
      version: 2,
      credentialVersion: 1,
      credentialStatus: 'connected',
    });
    expect(JSON.stringify(replaced)).not.toContain('private-connector-token');
    await expect(invoker.run(useCases.getConnection, pb, { id: created.id })).rejects.toMatchObject(
      { code: 'not_found' }
    );
    expect((await invoker.run(useCases.listConnections, pb, {})).connections).toEqual([]);
    const secret = await operatorDb
      .selectFrom('connection_credentials')
      .selectAll()
      .where('connection_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(secret.ciphertext).not.toContain('private-connector-token');
    expect(decryptCredential(secret.ciphertext, Buffer.from(key, 'hex'), a, created.id, 1)).toBe(
      'private-connector-token'
    );
    expect(() =>
      decryptCredential(secret.ciphertext, Buffer.from(key, 'hex'), b, created.id, 1)
    ).toThrow();
    const audit = await operatorDb
      .selectFrom('audit_log')
      .selectAll()
      .where('tenant_id', '=', a)
      .where('operation', 'like', 'connections.%')
      .execute();
    expect(JSON.stringify(audit)).not.toContain('private-connector-token');
    const tables = await sql<{
      table_name: string;
    }>`select table_name from information_schema.tables
      where table_schema = 'public' and table_name in ('connections', 'connection_credentials')`.execute(
      operatorDb
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual([
      'connection_credentials',
      'connections',
    ]);
    const disconnected = await invoker.run(useCases.disconnectConnection, pa, {
      id: created.id,
      baseVersion: replaced.version,
    });
    expect(disconnected).toMatchObject({
      state: 'disconnected',
      credentialStatus: 'reconnect-required',
      credentialVersion: 1,
    });
    expect(await invoker.run(useCases.getConnection, pa, { id: created.id })).toMatchObject({
      state: 'disconnected',
      credentialStatus: 'reconnect-required',
      credentialVersion: 1,
    });
    expect((await invoker.run(useCases.listConnections, pa, {})).connections).toContainEqual(
      expect.objectContaining({
        id: created.id,
        state: 'disconnected',
        credentialStatus: 'reconnect-required',
        credentialVersion: 1,
      })
    );
    expect(
      await operatorDb
        .selectFrom('connection_credentials')
        .select('connection_id')
        .where('connection_id', '=', created.id)
        .executeTakeFirst()
    ).toBeUndefined();
  });

  async function planned() {
    const p = systemPrincipal(a, 'connection-conformance');
    let c = await invoker.run(useCases.createConnection, p, input);
    c = await invoker.run(useCases.replaceConnectionCredential, p, {
      id: c.id,
      baseVersion: c.version,
      secret: 'test-only',
    });
    c = await invoker.run(useCases.resumeConnection, p, { id: c.id, baseVersion: c.version });
    const supporterId = uuidv7();
    const at = clock.now().toISOString();
    await uow.run(p, (ctx) =>
      ctx.supporters.saveProjection({
        id: supporterId,
        email: `${supporterId}@example.org`,
        lists: ['newsletter:main'],
        pendingLists: [],
        firstSeen: at,
        lastActivity: at,
        appliedThrough: { at, id: 'fixture' },
      })
    );
    const request = {
      connectionId: c.id,
      connectionVersion: c.version,
      businessId: uuidv7(),
      source: 'fixture',
      mappingVersion: 'v1',
      supporterId,
      scope: 'newsletter:main',
    };
    return { p, c, request };
  }

  it('rolls back intent and job together, deduplicates concurrent inserts, and fences stale updates', async () => {
    const { p, request } = await planned();
    let rolledBackId = '';
    await expect(
      uow.run(p, async (ctx) => {
        rolledBackId = (await planConnectionIntent(ctx, request)).id;
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    expect(
      await uow.run(p, (ctx) =>
        ctx.connectionIntents.byBusiness(request.connectionId, request.businessId)
      )
    ).toBeNull();
    expect(
      await withTenant(appDb, p, (trx) =>
        trx
          .selectFrom('jobs')
          .select('id')
          .where('key', '=', `connections.run:${a}:${rolledBackId}`)
          .execute()
      )
    ).toEqual([]);
    const rows = await Promise.all([
      uow.run(p, (ctx) => planConnectionIntent(ctx, request)),
      uow.run(p, (ctx) => planConnectionIntent(ctx, request)),
    ]);
    const row = rows[0]!;
    expect(rows[1]?.id).toBe(row.id);
    const jobs = await withTenant(appDb, p, (trx) =>
      trx
        .selectFrom('jobs')
        .select('id')
        .where('tenant_id', '=', a)
        .where('key', '=', `connections.run:${a}:${row.id}`)
        .execute()
    );
    expect(jobs).toHaveLength(1);
    const [first, second] = await Promise.all([
      uow.run(p, (ctx) =>
        ctx.connectionIntents.replace({ ...row, state: 'unknown' }, row.revision)
      ),
      uow.run(p, (ctx) =>
        ctx.connectionIntents.replace({ ...row, state: 'unknown' }, row.revision)
      ),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(
      await uow.run(systemPrincipal(b, 'test'), (ctx) => ctx.connectionIntents.get(row.id))
    ).toBeNull();
    expect(
      await uow.run(systemPrincipal(b, 'test'), (ctx) =>
        ctx.connectionIntents.replace({ ...row, state: 'succeeded' }, 1)
      )
    ).toBe(false);
    expect(TABLES.connection_intents).toBe('operational');
    expect(TABLES.connection_attempts).toBe('operational');
  });

  it('recovers committed uncertainty under RLS without a second effect and detaches erased references', async () => {
    const { p, request } = await planned();
    const row = await uow.run(p, (ctx) => planConnectionIntent(ctx, request));
    const transport = new FakeConnectionTransport();
    transport.result = 'unknown';
    const deps = {
      uow,
      clock,
      transport,
      identity: {
        tenantAccess: async () => ({ status: 'active' as const, entitlements: p.entitlements }),
      },
      sources: {
        fixture: { prepare: async () => ({ ready: true as const, payload: { synthetic: true } }) },
      },
    };
    await runConnectionIntent(deps, b, row.id);
    expect(transport.dispatched).toHaveLength(0);
    await Promise.all([runConnectionIntent(deps, a, row.id), runConnectionIntent(deps, a, row.id)]);
    expect(transport.dispatched).toHaveLength(1);
    clock.advance(120_000);
    transport.lookup = 'succeeded';
    await runConnectionIntent(deps, a, row.id);
    expect(transport.reconciled).toHaveLength(1);
    expect(await uow.run(p, (ctx) => ctx.connectionIntents.get(row.id))).toMatchObject({
      state: 'succeeded',
    });
    expect(
      await uow.run(systemPrincipal(b, 'test'), (ctx) => ctx.connectionIntents.attempts(row.id))
    ).toEqual([]);
    expect(await uow.run(p, (ctx) => ctx.connectionIntents.attempts(row.id))).toHaveLength(4);
    await uow.run(p, (ctx) =>
      ctx.erasures.register(request.supporterId, `${request.supporterId}@example.org`)
    );
    await applyErasures(operatorDb, a);
    expect(await uow.run(p, (ctx) => ctx.connectionIntents.get(row.id))).toMatchObject({
      state: 'succeeded',
      supporterId: null,
      failure: 'erasure',
    });
  });
});
