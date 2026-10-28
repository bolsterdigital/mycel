// The rules core owns and both adapters apply (ADR 001, TODO #53 PR 3): the credential gate,
// "disconnected is frozen" and what an erasure does to connection intents. One scenario, one
// expected record, run once over the memory adapter and once over Postgres; a rule that one
// adapter keeps on its own shows up as a difference here. Rejected: a suite per adapter, which
// is how memory came to block a `resolved` intent while Postgres kept it.
//
// The memory half always runs; the Postgres half skips without DATABASE_URL and APP_DATABASE_URL,
// and with E2E_REQUIRED=1 (CI) that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConnectionIntentState,
  erasedIntentState,
  systemPrincipal,
  type ConnectionIntent,
  type UnitOfWork,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryUnitOfWork,
  memoryPlatform,
} from '@mycel/core/testing';
import {
  applyErasures,
  createDb,
  createUnitOfWork,
  migrate,
  upsertTenant,
  uuidv7,
  uuidv7Ids,
} from './index.js';
import { closeTenantWork } from './testing.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but DATABASE_URL or APP_DATABASE_URL is not set');

interface Adapter {
  uow: UnitOfWork;
  tenant(): Promise<string>;
  apply(tenantId: string): Promise<unknown>;
}

const connection = {
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

/** Every observation the rules decide, in one record, so the two adapters compare as a whole. */
async function observe({ uow, tenant, apply }: Adapter) {
  const t = await tenant();
  const admin = systemPrincipal(t, 'adapter-rules');
  const worker = systemPrincipal(t, 'connections.run');
  const other = systemPrincipal(t, 'connections.other');
  const at = new Date('2026-10-28T08:00:00Z');
  const read = (p: typeof admin, id: string, version: number) =>
    uow.run(p, (ctx) => ctx.connections.credential(id, version));

  const created = await uow.run(admin, (ctx) =>
    ctx.connections.insert({ ...connection, id: uuidv7() }, at)
  );
  const withKey = (await uow.run(admin, (ctx) =>
    ctx.connections.replaceCredential(created.id, created.version, 'rule-secret', at)
  ))!;
  const paused = await read(worker, created.id, 1);
  const active = (await uow.run(admin, (ctx) =>
    ctx.connections.state(created.id, withKey.version, 'active', at)
  ))!;
  const credential = {
    paused,
    activeWorker: await read(worker, created.id, 1),
    activeStaleVersion: await read(worker, created.id, 2),
    activeOtherJob: await read(other, created.id, 1),
    activeAdmin: await read(admin, created.id, 1),
  };

  // A stale base version fails like a frozen row, so the frozen checks use the current one.
  const gone = (await uow.run(admin, (ctx) =>
    ctx.connections.state(created.id, active.version, 'disconnected', at)
  ))!;
  const frozen = {
    hasCredential: gone.hasCredential,
    read: await read(worker, created.id, 1),
    update: await uow.run(admin, (ctx) =>
      ctx.connections.update(created.id, gone.version, { purpose: 'Changed' }, at)
    ),
    resume: await uow.run(admin, (ctx) =>
      ctx.connections.state(created.id, gone.version, 'active', at)
    ),
    replaceCredential: await uow.run(admin, (ctx) =>
      ctx.connections.replaceCredential(created.id, gone.version, 'again', at)
    ),
  };

  // One intent per state for one supporter, against a second, live connection.
  const live = await uow.run(admin, (ctx) =>
    ctx.connections.insert({ ...connection, id: uuidv7() }, at)
  );
  const supporterId = uuidv7();
  const intents = new Map<string, ConnectionIntentState>();
  for (const state of ConnectionIntentState.options) {
    const row: ConnectionIntent = {
      id: uuidv7(),
      connectionId: live.id,
      businessId: uuidv7(),
      connectionVersion: live.version,
      credentialVersion: 1,
      source: 'form',
      mappingVersion: 'v1',
      supporterId,
      scope: 'newsletter:main',
      actor: { kind: 'system', id: 'adapter-rules' },
      key: `adapter-rules:${state}:${uuidv7()}`,
      state,
      failure: null,
      attempts: 1,
      revision: 0,
      leaseToken: null,
      leaseUntil: null,
      nextAt: at,
      createdAt: at,
      updatedAt: at,
    };
    await uow.run(admin, (ctx) => ctx.connectionIntents.insert(row));
    intents.set(row.id, state);
  }
  await uow.run(admin, (ctx) => ctx.erasures.register(supporterId, 'rules@example.org'));
  await apply(t);
  const erased: Record<string, unknown> = {};
  for (const [id, before] of intents) {
    const row = (await uow.run(admin, (ctx) => ctx.connectionIntents.get(id)))!;
    erased[before] = { state: row.state, failure: row.failure, supporterId: row.supporterId };
  }
  return { credential, frozen, erased };
}

const expected = {
  credential: {
    paused: null,
    activeWorker: 'rule-secret',
    activeStaleVersion: null,
    activeOtherJob: null,
    activeAdmin: null,
  },
  frozen: {
    hasCredential: false,
    read: null,
    update: null,
    resume: null,
    replaceCredential: null,
  },
  erased: Object.fromEntries(
    ConnectionIntentState.options.map((s) => [
      s,
      { state: erasedIntentState(s), failure: 'erasure', supporterId: null },
    ])
  ),
};

it('keeps an intent whose state says what happened, and blocks the rest', () => {
  expect(
    Object.fromEntries(ConnectionIntentState.options.map((s) => [s, erasedIntentState(s)]))
  ).toEqual({
    pending: 'blocked',
    unknown: 'unknown',
    succeeded: 'succeeded',
    blocked: 'blocked',
    failed: 'blocked',
    resolved: 'resolved',
  });
});

describe('adapter rules, memory', () => {
  it('applies the core rules', async () => {
    const uow = new MemoryUnitOfWork({ clock: new FakeClock(new Date()) });
    const result = await observe({
      uow,
      tenant: async () => uuidv7(),
      apply: (t) => uow.run(systemPrincipal(t, 'erasures'), (ctx) => ctx.erasures.apply()),
    });
    expect(result).toEqual(expected);
  });
});

describe.skipIf(!operatorUrl || !appUrl)('adapter rules, postgres', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
  const uow = createUnitOfWork(appDb, {
    clock: new FakeClock(new Date()),
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    connectionCredentialKey: '20'.repeat(32),
  });
  const run = Math.random().toString(36).slice(2, 8);
  const tenants: string[] = [];

  beforeAll(() => migrate(operatorUrl!, { log: () => {} }));
  afterAll(async () => {
    await closeTenantWork(operatorDb, tenants);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('applies the core rules', async () => {
    const result = await observe({
      uow,
      async tenant() {
        const { id } = await upsertTenant(
          operatorDb,
          {
            id: uuidv7(),
            slug: `rules-${run}`,
            name: 'Rules',
            defaultLocale: 'nl',
            locales: ['nl'],
          },
          { platformDomain: 'localhost' }
        );
        tenants.push(id);
        return id;
      },
      apply: (t) => applyErasures(operatorDb, t),
    });
    expect(result).toEqual(expected);
  });
});
