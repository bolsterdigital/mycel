// Real RLS and encryption, beyond the in-memory core test: tenant B must not see A's metadata
// or encrypted credential, and an export must not carry credential ciphertext.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
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
} from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but database URLs are unset');

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
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
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
  });
});
