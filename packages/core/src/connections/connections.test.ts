// The inventory's security contract: capability separation, tenant isolation and no secret in
// any returned or audited value. The registry conformance covers HTTP and MCP for each use case.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Capability, type Principal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/memory.js';
import { buildRegistry, useCases } from '../use-cases.js';

const A = '01900000-0000-7000-8000-00000000aaaa';
const B = '01900000-0000-7000-8000-00000000bbbb';
const input = {
  provider: 'webhook' as const,
  accountRef: null,
  externalOwner: 'Example organisation',
  maintainer: 'Operator',
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

describe('managed connection inventory', () => {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const principal = (tenantId: string, capabilities: Capability[]): Principal => ({
    ...systemPrincipal(tenantId, 'connection-test'),
    actor: { kind: 'api-key', keyId: 'test-key' },
    capabilities,
  });

  it('separates read, configure and credential rights while tenant:admin retains oversight', async () => {
    const configure = principal(A, ['connections:configure']);
    const read = principal(A, ['connections:read']);
    const credentials = principal(A, ['connections:credentials']);
    const created = await invoker.run(useCases.createConnection, configure, input);
    expect(created.state).toBe('paused');
    expect(created.credentialStatus).toBe('reconnect-required');
    await expect(invoker.run(useCases.listConnections, configure, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      invoker.run(useCases.updateConnection, read, {
        id: created.id,
        baseVersion: 1,
        changes: { purpose: 'Other' },
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      invoker.run(useCases.replaceConnectionCredential, configure, {
        id: created.id,
        baseVersion: 1,
        secret: 'top-secret',
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
    const replaced = await invoker.run(useCases.replaceConnectionCredential, credentials, {
      id: created.id,
      baseVersion: 1,
      secret: 'top-secret',
    });
    expect(replaced).toMatchObject({
      version: 2,
      credentialVersion: 1,
      credentialStatus: 'connected',
    });
    expect(JSON.stringify(await invoker.run(useCases.listConnections, read, {}))).not.toContain(
      'top-secret'
    );
    expect(JSON.stringify(uow.store.for(A).audit)).not.toContain('top-secret');
    expect(
      (await invoker.run(useCases.getConnection, systemPrincipal(A, 'admin'), { id: created.id }))
        .id
    ).toBe(created.id);
    const disconnected = await invoker.run(useCases.disconnectConnection, configure, {
      id: created.id,
      baseVersion: replaced.version,
    });
    expect(disconnected).toMatchObject({
      state: 'disconnected',
      credentialStatus: 'reconnect-required',
      credentialVersion: 1,
    });
    expect(await invoker.run(useCases.getConnection, read, { id: created.id })).toMatchObject({
      state: 'disconnected',
      credentialStatus: 'reconnect-required',
      credentialVersion: 1,
    });
    expect((await invoker.run(useCases.listConnections, read, {})).connections).toContainEqual(
      expect.objectContaining({
        id: created.id,
        state: 'disconnected',
        credentialStatus: 'reconnect-required',
        credentialVersion: 1,
      })
    );
  });

  it('does not cross tenants and fails stale or disconnected writes', async () => {
    const adminA = systemPrincipal(A, 'test');
    const adminB = systemPrincipal(B, 'test');
    const created = await invoker.run(useCases.createConnection, adminA, input);
    await expect(
      invoker.run(useCases.getConnection, adminB, { id: created.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect((await invoker.run(useCases.listConnections, adminB, {})).connections).toEqual([]);
    await expect(
      invoker.run(useCases.updateConnection, adminB, {
        id: created.id,
        baseVersion: 1,
        changes: { purpose: 'B' },
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    const updated = await invoker.run(useCases.updateConnection, adminA, {
      id: created.id,
      baseVersion: 1,
      changes: { destination: 'https://new.example.org/hook' },
    });
    expect(updated.version).toBe(2);
    await expect(
      invoker.run(useCases.pauseConnection, adminA, { id: created.id, baseVersion: 1 })
    ).rejects.toMatchObject({ code: 'conflict' });
    await invoker.run(useCases.disconnectConnection, adminA, { id: created.id, baseVersion: 2 });
    await expect(
      invoker.run(useCases.resumeConnection, adminA, { id: created.id, baseVersion: 3 })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('does not allow a suspended tenant to change a connection', async () => {
    const suspended = { ...systemPrincipal(A, 'test'), tenantStatus: 'suspended' as const };
    await expect(invoker.run(useCases.createConnection, suspended, input)).rejects.toMatchObject({
      code: 'suspended',
    });
  });

  it('refuses credentials embedded in an exportable destination', async () => {
    for (const destination of [
      'https://token@hooks.example.org/mycel',
      'https://hooks.example.org/mycel?token=secret',
      'https://hooks.example.org/mycel#secret',
    ])
      await expect(
        invoker.run(useCases.createConnection, systemPrincipal(A, 'test'), {
          ...input,
          destination,
        })
      ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// The intent engine reuses the inventory and registry boundaries, with a fake external system.
import { FakeClock, MemoryIdentityStore, MemoryTenants } from '../testing/memory.js';
import { FakeConnectionTransport } from '../testing/fake-connection-transport.js';
import { planConnectionIntent } from './intents.js';
import { runConnectionIntent, CONNECTION_LEASE_MS, type ConnectionSource } from './dispatch.js';

async function engine() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const principal = systemPrincipal(A, 'test');
  const identity = new MemoryIdentityStore(uow.store, new MemoryTenants());
  let c = await invoker.run(useCases.createConnection, principal, input);
  c = await invoker.run(useCases.replaceConnectionCredential, principal, {
    id: c.id,
    baseVersion: c.version,
    secret: 'never-export',
  });
  c = await invoker.run(useCases.resumeConnection, principal, { id: c.id, baseVersion: c.version });
  const supporterId = uow.ids.next();
  await uow.run(principal, (ctx) =>
    ctx.supporters.saveProjection({
      id: supporterId,
      email: 'reader@example.org',
      lists: ['newsletter:main'],
      pendingLists: [],
      firstSeen: clock.now().toISOString(),
      lastActivity: clock.now().toISOString(),
      appliedThrough: { at: clock.now().toISOString(), id: 'fixture' },
    })
  );
  const request = {
    connectionId: c.id,
    connectionVersion: c.version,
    businessId: uow.ids.next(),
    source: 'fixture',
    mappingVersion: 'v1',
    supporterId,
    scope: 'newsletter:main',
  };
  const transport = new FakeConnectionTransport();
  const policy = { suppressed: false, mapping: 'v1' };
  const source: ConnectionSource = {
    async prepare(_ctx, row) {
      if (row.mappingVersion !== policy.mapping) return { ready: false, failure: 'version' };
      if (policy.suppressed) return { ready: false, failure: 'suppression' };
      return { ready: true, payload: { synthetic: true } };
    },
  };
  const deps = { uow, identity, clock, transport, sources: { fixture: source } };
  const plan = () => uow.run(principal, (ctx) => planConnectionIntent(ctx, request));
  const read = (id: string) => uow.run(principal, (ctx) => ctx.connectionIntents.get(id));
  return { clock, uow, invoker, principal, c, request, transport, policy, deps, plan, read };
}

describe('durable connection effects', () => {
  it('deduplicates business intents and concurrent dispatch, and hides A from B', async () => {
    const e = await engine();
    const [a, b] = await Promise.all([e.plan(), e.plan()]);
    expect(a.id).toBe(b.id);
    expect(e.uow.store.jobs.filter((j) => j.type === 'connections.run')).toHaveLength(1);
    await runConnectionIntent(e.deps, B, a.id);
    expect(e.transport.dispatched).toHaveLength(0);
    await Promise.all([runConnectionIntent(e.deps, A, a.id), runConnectionIntent(e.deps, A, a.id)]);
    expect(e.transport.dispatched).toHaveLength(1);
    expect((await e.read(a.id))?.state).toBe('succeeded');
    await expect(
      e.invoker.run(useCases.getConnectionIntent, systemPrincipal(B, 'test'), { id: a.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      e.uow.run(e.principal, (ctx) =>
        planConnectionIntent(ctx, { ...e.request, mappingVersion: 'v2' })
      )
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      JSON.stringify(await e.invoker.run(useCases.getConnectionIntent, e.principal, { id: a.id }))
    ).not.toContain('reader@example.org');
  });

  it('never blindly replays timeout/unknown; only provider absence permits another dispatch', async () => {
    const e = await engine();
    const row = await e.plan();
    e.transport.result = 'unknown';
    await runConnectionIntent(e.deps, A, row.id);
    await e.invoker.run(useCases.replayConnectionIntent, e.principal, { id: row.id });
    e.clock.advance(120_000);
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(1);
    expect(e.transport.reconciled).toHaveLength(1);
    expect((await e.read(row.id))?.state).toBe('unknown');
    e.transport.lookup = 'absent';
    e.clock.advance(240_000);
    await runConnectionIntent(e.deps, A, row.id);
    expect((await e.read(row.id))?.state).toBe('pending');
    e.transport.result = 'succeeded';
    e.clock.advance(480_000);
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(2);
    expect(e.transport.dispatched[0]?.key).toBe(e.transport.dispatched[1]?.key);
  });

  it('reconciles a crash after committed claim even if transport never started', async () => {
    const e = await engine();
    const row = await e.plan();
    const prepare = e.deps.sources.fixture.prepare;
    e.deps.sources.fixture.prepare = async () => {
      throw new Error('simulated process death');
    };
    await expect(runConnectionIntent(e.deps, A, row.id)).rejects.toThrow('simulated');
    expect((await e.read(row.id))?.state).toBe('unknown');
    e.deps.sources.fixture.prepare = prepare;
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.reconciled).toHaveLength(0);
    e.clock.advance(CONNECTION_LEASE_MS * 3);
    e.transport.lookup = 'succeeded';
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect(e.transport.reconciled).toHaveLength(1);
    expect((await e.read(row.id))?.state).toBe('succeeded');
  });

  it.each([
    'paused',
    'disconnected',
    'consent',
    'suppression',
    'erasure',
    'version',
    'suspended',
  ] as const)('blocks current %s before an effect', async (kind) => {
    const e = await engine();
    const row = await e.plan();
    if (kind === 'paused' || kind === 'disconnected')
      await e.invoker.run(
        kind === 'paused' ? useCases.pauseConnection : useCases.disconnectConnection,
        e.principal,
        { id: e.c.id, baseVersion: e.c.version }
      );
    if (kind === 'consent') for (const p of e.uow.store.for(A).projections.values()) p.lists = [];
    if (kind === 'suppression') e.policy.suppressed = true;
    if (kind === 'version') e.policy.mapping = 'v2';
    if (kind === 'suspended') e.uow.store.setAccess(A, { status: 'suspended' });
    if (kind === 'erasure')
      await e.uow.run(e.principal, (ctx) =>
        ctx.erasures.register(e.request.supporterId, 'reader@example.org')
      );
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect((await e.read(row.id))?.failure).toBe(kind);
  });

  it('rechecks a pause between durable claim and preparation', async () => {
    const e = await engine();
    const row = await e.plan();
    const base = e.deps.uow;
    let calls = 0;
    e.deps.uow = {
      ...base,
      run: async (principal, fn) => {
        const result = await base.run(principal, fn);
        if (++calls === 1)
          await e.invoker.run(useCases.pauseConnection, e.principal, {
            id: e.c.id,
            baseVersion: e.c.version,
          });
        return result;
      },
    } as MemoryUnitOfWork;
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect((await e.read(row.id))?.failure).toBe('paused');
  });

  it('rechecks the originating key, and gives replay its own capability and audit', async () => {
    const e = await engine();
    const id = e.uow.ids.next();
    await e.uow.run(e.principal, (ctx) =>
      ctx.apiKeys.insert({
        id,
        name: 'fixture',
        prefix: 'test',
        keyHash: 'hash',
        capabilities: ['connections:configure'],
        createdBy: e.principal.actor,
        createdAt: e.clock.now(),
      })
    );
    const keyPrincipal = {
      ...e.principal,
      actor: { kind: 'api-key' as const, keyId: id },
      capabilities: ['connections:configure' as const],
    };
    const row = await e.uow.run(keyPrincipal, (ctx) => planConnectionIntent(ctx, e.request));
    await expect(
      e.invoker.run(useCases.replayConnectionIntent, keyPrincipal, { id: row.id })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await e.uow.run(e.principal, (ctx) => ctx.apiKeys.revoke(id, e.clock.now()));
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect((await e.read(row.id))?.failure).toBe('authorization');
    expect(e.uow.store.for(A).audit.some((a) => a.operation === 'connections.intent.replay')).toBe(
      true
    );
  });

  it('bounds retries, preserves manual unknown and never stores thrown provider text', async () => {
    const e = await engine();
    const row = await e.plan();
    e.transport.dispatch = async () => {
      throw new Error('private-token reader@example.org');
    };
    for (let i = 0; i < 8; i++) {
      await runConnectionIntent(e.deps, A, row.id);
      e.clock.advance(3_600_000);
    }
    expect(e.transport.reconciled).toHaveLength(4);
    expect(await e.read(row.id)).toMatchObject({ state: 'unknown', attempts: 5 });
    expect(JSON.stringify(await e.read(row.id))).not.toContain('private-token');
    await expect(
      e.invoker.run(useCases.replayConnectionIntent, e.principal, { id: row.id })
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('backs off a definite pre-send failure and rechecks consent before retry', async () => {
    const e = await engine();
    const row = await e.plan();
    e.transport.result = 'pre_send';
    await runConnectionIntent(e.deps, A, row.id);
    expect((await e.read(row.id))?.state).toBe('pending');
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(1);
    for (const p of e.uow.store.for(A).projections.values()) p.lists = [];
    e.clock.advance(120_000);
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(1);
  });

  it('checks pause again after asynchronous source preparation', async () => {
    const e = await engine();
    const row = await e.plan();
    e.deps.sources.fixture.prepare = async () => {
      await e.invoker.run(useCases.pauseConnection, e.principal, {
        id: e.c.id,
        baseVersion: e.c.version,
      });
      return { ready: true, payload: { synthetic: true } };
    };
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect((await e.read(row.id))?.failure).toBe('paused');
  });

  it.each([false, true])(
    'checks suspension after source preparation and preserves prior uncertainty (%s)',
    async (unknown) => {
      const e = await engine();
      const row = await e.plan();
      if (unknown) {
        e.transport.result = 'unknown';
        await runConnectionIntent(e.deps, A, row.id);
        e.clock.advance(120_000);
      }
      e.deps.sources.fixture.prepare = async () => {
        e.uow.store.setAccess(A, { status: 'suspended' });
        return { ready: true, payload: { synthetic: true } };
      };
      await runConnectionIntent(e.deps, A, row.id);
      expect((await e.deps.identity.tenantAccess(A)).status).toBe('suspended');
      expect(e.transport.dispatched).toHaveLength(unknown ? 1 : 0);
      expect(e.transport.reconciled).toHaveLength(0);
      expect(await e.read(row.id)).toMatchObject({
        state: unknown ? 'unknown' : 'blocked',
        failure: 'suspended',
        leaseToken: null,
        leaseUntil: null,
      });
    }
  );

  it('fences late completions after another worker reconciles the expired lease', async () => {
    const e = await engine();
    const row = await e.plan();
    let finish!: (result: 'pre_send') => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    e.transport.dispatch = async () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const first = runConnectionIntent(e.deps, A, row.id);
    await started;
    e.clock.advance(120_000);
    e.transport.lookup = 'succeeded';
    await runConnectionIntent(e.deps, A, row.id);
    finish('pre_send');
    await first;
    expect((await e.read(row.id))?.state).toBe('succeeded');
  });

  it('defers at the tenant quota without consuming a delivery attempt', async () => {
    const e = await engine();
    const row = await e.plan();
    await e.uow.run(e.principal, async (ctx) => {
      for (let i = 0; i < 60; i++)
        await ctx.rateLimits.hit('connections:dispatch', { max: 60, windowSeconds: 60 });
    });
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect(await e.read(row.id)).toMatchObject({ state: 'pending', attempts: 0, failure: 'quota' });
    e.clock.advance(60_000);
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(1);
  });
});
