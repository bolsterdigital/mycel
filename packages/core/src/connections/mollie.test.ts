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
