// A `mollie` connection holds a site's Mollie API key for the payment adapter (MY-252 PR 3): no
// destination, forms or scopes, and only a test or live key as its credential.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { MemoryUnitOfWork, expectCode, principal } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';

const mollie = {
  provider: 'mollie' as const,
  accountRef: null,
  externalOwner: 'Probe',
  maintainer: 'Operator',
  purpose: 'Donations',
  direction: 'outbound' as const,
  dataAuthority: 'mycel' as const,
  consentAuthority: 'mycel' as const,
  consentScopes: [],
  formIds: [],
  destination: null,
  contractVersion: 'v1',
  adapterVersion: 'v1',
};

describe('a Mollie connection', () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
  const admin = principal({
    capabilities: ['connections:configure', 'connections:credentials', 'connections:read'],
  });

  it('takes a key and nothing to deliver to', async () => {
    const created = await invoker.run(useCases.createConnection, admin, mollie);
    await expectCode(
      invoker.run(useCases.replaceConnectionCredential, admin, {
        id: created.id,
        baseVersion: created.version,
        secret: 'sk_live_not-a-mollie-key-at-all-1234',
      }),
      'invalid_input'
    );
    const keyed = await invoker.run(useCases.replaceConnectionCredential, admin, {
      id: created.id,
      baseVersion: created.version,
      secret: `test_${'x'.repeat(30)}`,
    });
    expect(keyed.credentialStatus).toBe('connected');
    const active = await invoker.run(useCases.resumeConnection, admin, {
      id: created.id,
      baseVersion: keyed.version,
    });
    expect(active.state).toBe('active');
    expect(JSON.stringify(active)).not.toContain('test_xxx');
  });

  // MY-262 PR 3: the mode is read from the prefix when the key is saved, shown without the key,
  // and turns the launch step `mollie-live` from a manual tick into a check.
  it('keeps whether the key is a test or a live key, and the launch checklist reads it', async () => {
    const owner = principal({
      capabilities: [
        'connections:configure',
        'connections:credentials',
        'connections:read',
        'tenant:admin',
      ],
    });
    const own = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const step = async () =>
      (await own.run(useCases.getLaunchChecklist, owner, {})).phases
        .flatMap((p) => p.steps)
        .find((s) => s.id === 'mollie-live')!;
    const created = await own.run(useCases.createConnection, owner, mollie);
    expect(created.credentialMode).toBeNull();
    const save = async (secret: string, baseVersion: number) =>
      own.run(useCases.replaceConnectionCredential, owner, { id: created.id, baseVersion, secret });

    const test = await save(`test_${'x'.repeat(30)}`, created.version);
    expect(test.credentialMode).toBe('test');
    expect((await step()).detail?.code).toBe('mollie-live.test');

    const live = await save(`live_${'y'.repeat(30)}`, test.version);
    const [listed] = (await own.run(useCases.listConnections, owner, {})).connections;
    expect(listed!.credentialMode).toBe('live');
    expect(JSON.stringify(listed)).not.toContain('live_yyy');
    expect((await step()).detail?.code).toBe('mollie-live.ok');

    await own.run(useCases.disconnectConnection, owner, {
      id: created.id,
      baseVersion: live.version,
    });
    const [gone] = (await own.run(useCases.listConnections, owner, {})).connections;
    expect(gone!.credentialMode).toBeNull();
  });

  it('refuses a destination, forms or scopes', async () => {
    await expectCode(
      invoker.run(useCases.createConnection, admin, {
        ...mollie,
        destination: 'https://hooks.example.org/x',
      }),
      'invalid_input'
    );
    await expectCode(
      invoker.run(useCases.createConnection, admin, { ...mollie, consentScopes: ['news'] }),
      'invalid_input'
    );
    const created = await invoker.run(useCases.createConnection, admin, mollie);
    await expectCode(
      invoker.run(useCases.updateConnection, admin, {
        id: created.id,
        baseVersion: created.version,
        changes: { consentScopes: ['news'] },
      }),
      'invalid_input'
    );
  });
});
