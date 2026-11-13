// No stored actor carries an address (ADR 035 rule 4, #224). An operator principal whose actor
// object holds an e-mail address at run time, as a session decoded into a principal could, goes
// through the real adapters that persist an actor: a revision, a bulk plan and its effect, a media
// row, an API key, a presence beat and the person register. Afterwards the address is in no line
// of the tenant's export (the membership line is the one place an address belongs) and in no
// stored API key or presence row, which the export leaves out. Migration 0053 has its own suite
// (stored-actor-migration.test.ts); the import of an older archive is in export.conformance.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  type Actor,
  type Principal,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryBlobStore,
  memoryImageProcessor,
  memoryPlatform,
  principal,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7, uuidv7Ids } from './index.js';
import { enterTenant } from './infra/roles.js';
import { readTenant } from './portability/export.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('stored actors over Postgres (ADR 035 rule 4)', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const invoker = new Invoker(
    buildRegistry(),
    createUnitOfWork(appDb, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns({}),
      platform: memoryPlatform,
      media: { blobs: new MemoryBlobStore(), images: memoryImageProcessor },
      connectionCredentialKey: '10'.repeat(32),
    })
  );
  const run = runSuffix();
  const address = `stored-actor-${run}@example.org`;
  let tenant = '';
  let operatorId = '';
  let editor: Principal;

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenant = (await testTenant(operatorDb, `stored-actor-${run}`)).id;
    const member = await invoker.run(useCases.inviteMember, systemPrincipal(tenant, 't'), {
      email: address,
      capabilities: ['tenant:admin'],
    });
    operatorId = member.operatorId;
    editor = principal({
      tenantId: tenant,
      capabilities: ['tenant:admin'],
      // More than the type allows, on purpose: what a front might hand the core.
      actor: { kind: 'operator', operatorId, email: address } as Actor,
    });
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [tenant]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('writes every actor without the address an operator principal carried', async () => {
    const { item } = await invoker.run(useCases.createItem, editor, {
      ...useCases.createItem.examples[0].input,
      slug: `stored-actor-${run}`,
    });
    const plan = await invoker.run(useCases.createBulk, editor, {
      locale: 'nl',
      items: [
        {
          itemId: item.id,
          baseRevisionId: item.latestRevisionId,
          operation: { kind: 'unpublish' },
        },
      ],
    });
    await invoker.run(useCases.resumeBulk, editor, { planId: plan.id, version: 1, ordinal: 0 });
    await invoker.run(useCases.uploadMedia, editor, useCases.uploadMedia.examples[0].input);
    await invoker.run(useCases.createKey, editor, {
      name: 'Stored actor',
      capabilities: ['content:read'],
    });
    await invoker.run(useCases.updatePresence, editor, {
      itemId: item.id,
      sessionId: uuidv7(),
      state: 'editing',
    });
    const person = await invoker.run(useCases.createPerson, editor, {
      ...useCases.createPerson.examples[0].input,
      slug: `stored-actor-${run}`,
    });
    await invoker.run(useCases.erasePeople, editor, { personIds: [person.id] });

    const lines = new Map<string, string[]>();
    await readTenant(operatorDb, tenant, (table, line) => {
      lines.set(table, [...(lines.get(table) ?? []), line]);
    });
    // Each persisting adapter above left a row, so the check below covers it.
    for (const table of [
      'content_revisions',
      'content_bulk_plans',
      'content_bulk_effects',
      'media',
      'person_erasures',
    ])
      expect(lines.get(table)?.length, table).toBeGreaterThan(0);
    expect(lines.get('tenant_memberships')?.join()).toContain(address);
    const leaked = [...lines].filter(
      ([table, rows]) => table !== 'tenant_memberships' && rows.some((l) => l.includes(address))
    );
    expect(leaked.map(([table]) => table)).toEqual([]);

    const raw = await operatorDb.transaction().execute(async (trx) => {
      await enterTenant(trx, tenant);
      const keys = await sql<{ v: string }>`select created_by::text as v from api_keys`.execute(
        trx
      );
      const presence = await sql<{
        v: string;
      }>`select actor::text as v from content_presence`.execute(trx);
      return [...keys.rows, ...presence.rows].map((r) => r.v);
    });
    expect(raw.length).toBeGreaterThanOrEqual(2);
    expect(raw.filter((v) => v.includes(address))).toEqual([]);
    expect(raw.filter((v) => v.includes(`"operatorId": "${operatorId}"`))).toHaveLength(2);
  });
});
