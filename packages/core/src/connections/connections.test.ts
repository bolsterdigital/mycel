// The inventory's security contract: capability separation, tenant isolation and no secret in
// any returned or audited value. The registry conformance covers HTTP and MCP for each use case.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { systemPrincipal, type Capability, type Principal } from '../principal.js';
import { FakeDns, MemoryUnitOfWork } from '../testing/memory.js';
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

/** The destination host of every fixture resolves to a public address, as a real one would. */
function publicDns(): FakeDns {
  return new FakeDns({
    'hooks.example.org': ['8.8.8.8'],
    'new.example.org': ['2606:4700:4700::1111'],
  });
}

describe('managed connection inventory', () => {
  const uow = new MemoryUnitOfWork({ dns: publicDns() });
  const invoker = new Invoker(buildRegistry(), uow);
  const keyOf = (tenantId: string, capabilities: Capability[]): Principal =>
    principal({ tenantId, actor: { kind: 'api-key', keyId: 'test-key' }, capabilities });

  it('separates read, configure and credential rights while tenant:admin retains oversight', async () => {
    const configure = keyOf(A, ['connections:configure']);
    const read = keyOf(A, ['connections:read']);
    const credentials = keyOf(A, ['connections:credentials']);
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
    const suspended = principal({ tenantId: A, tenantStatus: 'suspended' });
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

  it('checks the destination through the DNS port and refuses a private answer', async () => {
    const dns = publicDns();
    dns.addressRecords.set('internal.example.org', ['8.8.8.8', '10.0.0.5']);
    dns.unavailable.add('flaky.example.org');
    const local = new Invoker(buildRegistry(), new MemoryUnitOfWork({ dns }));
    const admin = keyOf(A, ['tenant:admin']);
    for (const [destination, message] of [
      ['https://internal.example.org/hook', 'not public'],
      ['https://unknown.example.org/hook', 'not public'],
      ['https://flaky.example.org/hook', 'unavailable'],
      ['https://localhost/hook', 'port 443'],
    ] as const)
      await expect(
        local.run(useCases.createConnection, admin, { ...input, destination })
      ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(message) });
    const c = await local.run(useCases.createConnection, admin, input);
    await expect(
      local.run(useCases.updateConnection, admin, {
        id: c.id,
        baseVersion: c.version,
        changes: { destination: 'https://internal.example.org/hook' },
      })
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

// The intent engine reuses the inventory and registry boundaries, with a fake external system.
import { FakeClock, MemoryIdentityStore, MemoryTenants } from '../testing/memory.js';
import { FakeConnectionTransport } from '../testing/fake-connection-transport.js';
import { connectionIntentGuard, planConnectionIntent } from './intents.js';
import {
  runConnectionIntent,
  CONNECTION_LEASE_MS,
  type ConnectionDispatchDeps,
} from './dispatch.js';
import type { ConnectionSource } from './ports.js';
import { CONNECTION_MAX_ATTEMPTS, ConnectionFailure } from './intents.js';
import { principal } from '../testing/index.js';

async function engine() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock, dns: publicDns() });
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
  const policy = { mapping: 'v1' };
  const source: ConnectionSource = {
    async prepare(_ctx, row) {
      if (row.mappingVersion !== policy.mapping) return { ready: false, failure: 'version' };
      return { ready: true, payload: { synthetic: true } };
    },
  };
  const deps: ConnectionDispatchDeps = {
    uow,
    identity,
    clock,
    transport,
    sources: { fixture: source },
  };
  const plan = () => uow.run(principal, (ctx) => planConnectionIntent(ctx, request));
  const read = (id: string) => uow.run(principal, (ctx) => ctx.connectionIntents.get(id));
  return {
    clock,
    uow,
    invoker,
    principal,
    c,
    request,
    transport,
    policy,
    deps,
    source,
    plan,
    read,
    repeat: 1,
  };
}
type Engine = Awaited<ReturnType<typeof engine>>;

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
    // A webhook cannot reconcile, so an operator cannot ask for a replay of an unknown intent;
    // the worker below reconciles only because this fake transport offers that proof.
    await expect(
      e.invoker.run(useCases.replayConnectionIntent, e.principal, { id: row.id })
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('manual') });
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

  it('leaves an unknown intent for an operator when the transport cannot reconcile', async () => {
    const e = await engine();
    const row = await e.plan();
    e.transport.result = 'unknown';
    // The webhook's shape: dispatch only, no reconcile proof.
    e.deps.transport = { dispatch: (input) => e.transport.dispatch(input) };
    expect(await runConnectionIntent(e.deps, A, row.id)).toEqual({});
    for (let i = 0; i < 3; i++) {
      e.clock.advance(3_600_000);
      expect(await runConnectionIntent(e.deps, A, row.id)).toEqual({});
    }
    expect(e.transport.dispatched).toHaveLength(1);
    expect(await e.read(row.id)).toMatchObject({ state: 'unknown', attempts: 1 });
    const status = await e.invoker.run(useCases.getConnectionIntent, e.principal, { id: row.id });
    expect(status.operatorAction).toBe('resolve');
  });

  it('resolves an unknown webhook intent by hand, with an audit row, and never sends it again', async () => {
    const e = await engine();
    const row = await e.plan();
    await expect(
      e.invoker.run(useCases.resolveConnectionIntent, e.principal, { id: row.id })
    ).rejects.toMatchObject({ code: 'conflict' });
    e.transport.result = 'unknown';
    let release!: () => void;
    const dispatch = e.transport.dispatch.bind(e.transport);
    e.transport.dispatch = async (input) => {
      await new Promise<void>((resolve) => (release = resolve));
      return dispatch(input);
    };
    const running = runConnectionIntent(e.deps, A, row.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Under a live lease the attempt may still report its result; resolving would race it.
    await expect(
      e.invoker.run(useCases.resolveConnectionIntent, e.principal, { id: row.id })
    ).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('attempted') });
    release();
    await running;
    const resolved = await e.invoker.run(useCases.resolveConnectionIntent, e.principal, {
      id: row.id,
    });
    expect(resolved).toMatchObject({ state: 'resolved', operatorAction: null });
    expect(
      e.uow.store
        .for(A)
        .audit.some((a) => a.operation === 'connection.intent.resolve' && a.subjectId === row.id)
    ).toBe(true);
    e.clock.advance(3_600_000);
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(1);
    expect(e.transport.reconciled).toHaveLength(0);
    for (const useCase of [useCases.replayConnectionIntent, useCases.resolveConnectionIntent])
      await expect(e.invoker.run(useCase, e.principal, { id: row.id })).rejects.toMatchObject({
        code: 'conflict',
      });
  });

  it('reconciles a crash after committed claim even if transport never started', async () => {
    const e = await engine();
    const row = await e.plan();
    const prepare = e.source.prepare;
    e.source.prepare = async () => {
      throw new Error('simulated process death');
    };
    await expect(runConnectionIntent(e.deps, A, row.id)).rejects.toThrow('simulated');
    expect((await e.read(row.id))?.state).toBe('unknown');
    e.source.prepare = prepare;
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.reconciled).toHaveLength(0);
    e.clock.advance(CONNECTION_LEASE_MS * 3);
    e.transport.lookup = 'succeeded';
    await runConnectionIntent(e.deps, A, row.id);
    expect(e.transport.dispatched).toHaveLength(0);
    expect(e.transport.reconciled).toHaveLength(1);
    expect((await e.read(row.id))?.state).toBe('succeeded');
  });

  // Every failure class has a scenario that produces it, so a class cannot exist without code
  // behind it (TODO #49). Adding a class to the enum fails the type check here until it has one.
  const produce: Record<ConnectionFailure, (e: Engine, id: string) => Promise<void>> = {
    paused: (e) =>
      e.invoker
        .run(useCases.pauseConnection, e.principal, { id: e.c.id, baseVersion: e.c.version })
        .then(() => undefined),
    disconnected: (e) =>
      e.invoker
        .run(useCases.disconnectConnection, e.principal, { id: e.c.id, baseVersion: e.c.version })
        .then(() => undefined),
    version: async (e) => void (e.policy.mapping = 'v2'),
    credential: (e, id) =>
      e.uow.run(e.principal, async (ctx) => {
        const row = (await ctx.connectionIntents.get(id))!;
        await ctx.connectionIntents.replace(
          { ...row, credentialVersion: row.credentialVersion + 1 },
          row.revision
        );
      }),
    authorization: (e, id) =>
      e.uow.run(e.principal, async (ctx) => {
        const row = (await ctx.connectionIntents.get(id))!;
        await ctx.connectionIntents.replace(
          { ...row, actor: { kind: 'api-key', id: 'revoked-or-missing' } },
          row.revision
        );
      }),
    consent: async (e) => {
      for (const p of e.uow.store.for(A).projections.values()) p.lists = [];
    },
    erasure: (e) =>
      e.uow.run(e.principal, (ctx) =>
        ctx.erasures.register(e.request.supporterId, 'reader@example.org')
      ),
    suspended: async (e) => e.uow.store.setAccess(A, { status: 'suspended' }),
    source: async (e) => void (e.deps.sources = {}),
    quota: (e) =>
      e.uow.run(e.principal, async (ctx) => {
        for (let i = 0; i < 60; i++)
          await ctx.rateLimits.hit('connections:dispatch', { max: 60, windowSeconds: 60 });
      }),
    pre_send: async (e) => void (e.transport.result = 'pre_send'),
    ambiguous: async (e) => void (e.transport.result = 'unknown'),
    exhausted: async (e) => {
      e.transport.result = 'pre_send';
      e.repeat = CONNECTION_MAX_ATTEMPTS;
    },
  };
  it.each(ConnectionFailure.options)('produces failure class %s', async (kind) => {
    const e = await engine();
    const row = await e.plan();
    await produce[kind](e, row.id);
    for (let i = 0; i < e.repeat; i++) {
      await runConnectionIntent(e.deps, A, row.id);
      e.clock.advance(3_600_000);
    }
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
    expect(e.uow.store.for(A).audit.some((a) => a.operation === 'connection.intent.replay')).toBe(
      true
    );
  });

  // One authorization rule (`grants`, behind `can`): a key and an operator holding the same
  // capabilities get the same answer when the worker rechecks the actor that planned the intent.
  it.each([
    [['connections:configure'], null],
    [['connections:read'], 'authorization'],
    [['connections:replay'], 'authorization'],
  ] as const)('rechecks an operator and an API key alike: %j', async (capabilities, expected) => {
    const e = await engine();
    const row = await e.plan();
    const keyId = e.uow.ids.next();
    e.uow.store.operators.set('op-alike', {
      id: 'op-alike',
      issuer: null,
      subject: null,
      email: 'alike@example.org',
      emailVerifiedAt: null,
      name: null,
      lastLoginAt: null,
    });
    e.uow.store.for(A).members.set('op-alike', {
      capabilities: [...capabilities],
      createdAt: new Date(0),
    });
    await e.uow.run(e.principal, (ctx) =>
      ctx.apiKeys.insert({
        id: keyId,
        name: 'alike',
        prefix: 'test',
        keyHash: 'hash',
        capabilities: [...capabilities],
        createdBy: e.principal.actor,
        createdAt: e.clock.now(),
      })
    );
    const outcome = (actor: (typeof row)['actor']) =>
      e.uow.run(e.principal, (ctx) => connectionIntentGuard(ctx, { ...row, actor }));
    expect(await outcome({ kind: 'operator', id: 'op-alike' })).toBe(expected);
    expect(await outcome({ kind: 'api-key', id: keyId })).toBe(expected);
  });

  it('honours tenant:admin on a rechecked operator as can() does', async () => {
    const e = await engine();
    const row = await e.plan();
    e.uow.store.operators.set('op-admin', {
      id: 'op-admin',
      issuer: null,
      subject: null,
      email: 'admin@example.org',
      emailVerifiedAt: null,
      name: null,
      lastLoginAt: null,
    });
    e.uow.store.for(A).members.set('op-admin', {
      capabilities: ['tenant:admin'],
      createdAt: new Date(0),
    });
    expect(
      await e.uow.run(e.principal, (ctx) =>
        connectionIntentGuard(ctx, { ...row, actor: { kind: 'operator', id: 'op-admin' } })
      )
    ).toBeNull();
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
    e.source.prepare = async () => {
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
      e.source.prepare = async () => {
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
