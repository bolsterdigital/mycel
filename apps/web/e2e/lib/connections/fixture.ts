// Ambiguous deliveries are stable fixtures; the live worker may make the UI's test ambiguous
// too. Rejected: selecting a row by status, which identifies neither the seeded attempt nor
// the newly queued one. Keep both known ids so resolution can prove which attempt changed.
import { SYNTHETIC_SCOPE, SYNTHETIC_SOURCE, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns } from '@mycel/core/testing';
import { uuidv7Ids } from '@mycel/db';
import { tenantId, withInvoker } from '../invoker';

export async function connectionFixture(project: string) {
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const purpose = `Synthetic webhook ${project} ${Date.now()}`;
  return withInvoker(
    async (invoker, uow) => {
      const connection = await invoker.run(useCases.createConnection, principal, {
        provider: 'webhook',
        accountRef: null,
        externalOwner: 'Synthetic owner',
        maintainer: 'Synthetic operator',
        purpose,
        direction: 'outbound',
        dataAuthority: 'mycel',
        consentAuthority: 'mycel',
        consentScopes: ['newsletter:main'],
        formIds: [],
        destination: 'https://hooks.example.org/mycel',
        contractVersion: 'v1',
        adapterVersion: 'v1',
      });
      // Two ambiguous attempts make status-based selection fail deterministically, even when
      // the worker has not yet processed the synthetic test queued by the UI below.
      const intentId = uuidv7Ids.next();
      const otherIntentId = uuidv7Ids.next();
      const at = new Date();
      for (const id of [intentId, otherIntentId]) {
        await uow.run(principal, (ctx) =>
          ctx.connectionIntents.insert({
            id,
            connectionId: connection.id,
            businessId: uuidv7Ids.next(),
            connectionVersion: connection.version,
            credentialVersion: 1,
            source: SYNTHETIC_SOURCE,
            mappingVersion: 'v1',
            supporterId: null,
            scope: SYNTHETIC_SCOPE,
            actor: { kind: 'system', id: 'e2e' },
            key: `e2e-${uuidv7Ids.next()}`,
            state: 'unknown',
            failure: 'ambiguous',
            attempts: 1,
            revision: 0,
            leaseToken: null,
            leaseUntil: null,
            nextAt: at,
            createdAt: at,
            updatedAt: at,
          })
        );
      }
      return { purpose, id: connection.id, intentId, otherIntentId };
    },
    {
      dns: new FakeDns({ 'hooks.example.org': ['8.8.8.8'] }),
      connectionCredentialKey: process.env['CONNECTION_CREDENTIAL_KEY'],
    }
  );
}
