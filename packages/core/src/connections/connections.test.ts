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
