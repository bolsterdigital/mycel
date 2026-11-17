// No stored actor carries an address (ADR 035 rule 4). An operator principal whose actor object
// holds an e-mail address at run time, as a session decoded into a principal could, goes through
// every real adapter that persists an actor: a revision, a bulk plan and its effect, a media row,
// an API key, a presence beat, both erasure registers, the form feed settings, a connection intent
// and an outbox event. Afterwards every column the storage catalog lists as an operator copy is
// read raw: the address is in none of them, and each operator actor holds its kind and its id and
// nothing else. The columns come from the catalog and the eleven tables from migration 0053
// itself, so a new actor column joins this check the moment it is catalogued, and a table the
// migration cleans cannot go unread here. The export is read as well: there the membership line
// is the one place an address belongs.
// Form feeds and connection intents get their actor from core as `{ kind, id }` already, so their
// adapters are also handed an object with an address directly; otherwise a missing
// `storedActorJson` there would never show.
// Migration 0053 has its own suite (stored-actor-migration.test.ts); the import of an older
// archive is in export.conformance, and storage.conformance holds the import's list of actor
// fields to the catalog.
// Rejected: a list of actor columns kept in this file (a twelfth column would be stored unread).
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  planConnectionIntent,
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
import { readTenant } from './portability/export.js';
import { STORAGE } from './portability/storage.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

const MIGRATION = new URL('../migrations/0053_stored_actor_ids.sql', import.meta.url);

/** Every `table.column` the catalog lists as a copy of an operator on a tenant's rows. */
const OPERATOR_COPIES = Object.entries(STORAGE).flatMap(([table, entry]) =>
  entry.owner === 'tenant'
    ? [
        ...new Set(
          entry.copies
            .filter((c) => c.subject === 'operator')
            .map((c) => `${table}.${c.field.split('.')[0]}`)
        ),
      ]
    : []
);

/** The operator actors inside one stored value: the value itself, or its `actor` (a bulk effect). */
function operatorActors(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  const v = value as Record<string, unknown>;
  return [v, v['actor']].filter(
    (a): a is Record<string, unknown> =>
      typeof a === 'object' && a !== null && (a as Record<string, unknown>)['kind'] === 'operator'
  );
}

describe.skipIf(skip)('stored actors over Postgres (ADR 035 rule 4)', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns({ 'hooks.example.org': ['8.8.8.8'] }),
    platform: memoryPlatform,
    media: { blobs: new MemoryBlobStore(), images: memoryImageProcessor },
    connectionCredentialKey: '10'.repeat(32),
  });
  const invoker = new Invoker(buildRegistry(), uow);
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

    // The supporter register, the feed settings and a connection intent, the last two also with
    // an address handed straight to the adapter.
    const wide = { kind: 'operator', id: operatorId, email: address } as never;
    const supporterId = uuidv7();
    const at = new Date().toISOString();
    await uow.run(systemPrincipal(tenant, 't'), (ctx) =>
      ctx.supporters.saveProjection({
        id: supporterId,
        email: `supporter-${run}@example.org`,
        lists: ['newsletter:main'],
        pendingLists: [],
        grants: [],
        firstSeen: at,
        lastActivity: at,
        appliedThrough: { at, id: 'fixture' },
      })
    );
    const feeds = await invoker.run(useCases.updateFormFeeds, editor, {
      baseVersion: 0,
      value: { feeds: [] },
    });
    await uow.run(editor, (ctx) => ctx.formFeeds.save(feeds.version, { feeds: [] }, wide));
    let connection = await invoker.run(useCases.createConnection, editor, {
      provider: 'webhook',
      accountRef: null,
      externalOwner: 'Example organisation',
      maintainer: 'Maintainer',
      purpose: 'Newsletter',
      direction: 'outbound',
      dataAuthority: 'mycel',
      consentAuthority: 'mycel',
      consentScopes: ['newsletter:main'],
      formIds: [],
      destination: 'https://hooks.example.org/mycel',
      contractVersion: 'v1',
      adapterVersion: 'v1',
    });
    connection = await invoker.run(useCases.replaceConnectionCredential, editor, {
      id: connection.id,
      baseVersion: connection.version,
      secret: 'test-only',
    });
    connection = await invoker.run(useCases.resumeConnection, editor, {
      id: connection.id,
      baseVersion: connection.version,
    });
    await invoker.run(useCases.testConnection, editor, { id: connection.id });
    await uow.run(editor, (ctx) =>
      planConnectionIntent(
        ctx,
        {
          connectionId: connection.id,
          connectionVersion: connection.version,
          businessId: uuidv7(),
          source: 'fixture',
          mappingVersion: 'v1',
          supporterId,
          scope: 'newsletter:main',
        },
        { actor: wide, retainBlocked: true }
      )
    );
    await invoker.run(useCases.eraseSupporter, editor, { supporterId });
    // No use case publishes an event as an operator today; the outbox adapter gets one directly.
    await uow.run(editor, (ctx) =>
      ctx.events.publish({
        id: uuidv7(),
        type: 'test.untouched',
        tenantId: tenant,
        occurredAt: new Date(),
        actor: editor.actor,
        props: {},
      })
    );

    // Every operator copy of the catalog, raw. The eleven columns migration 0053 cleaned are
    // among them, and each holds a row of the flow above.
    const migrated = [
      ...(await readFile(MIGRATION, 'utf8')).matchAll(/^update (\w+) set (\w+) =/gm),
    ].map((m) => `${m[1]}.${m[2]}`);
    expect(migrated).toHaveLength(11);
    expect(
      migrated.filter((c) => !OPERATOR_COPIES.includes(c)),
      'actor columns of 0053 the catalog does not list as an operator copy'
    ).toEqual([]);
    const stored = new Map<string, unknown[]>();
    for (const copy of OPERATOR_COPIES) {
      const [table, column] = copy.split('.') as [string, string];
      const { rows } = await sql<{ v: unknown }>`
        select to_jsonb(${sql.ref(column)}) as v from ${sql.table(table)}
        where tenant_id = ${tenant} and ${sql.ref(column)} is not null`.execute(operatorDb);
      stored.set(
        copy,
        rows.map((r) => r.v)
      );
    }
    expect(
      [...stored].filter(([, values]) => JSON.stringify(values).includes(address)).map(([c]) => c),
      'operator copies that hold the address'
    ).toEqual([]);
    for (const copy of migrated) {
      const actors = (stored.get(copy) ?? []).flatMap(operatorActors);
      const own = actors.filter((a) => (a['operatorId'] ?? a['id']) === operatorId);
      expect(own.length, `${copy}: no actor of this flow`).toBeGreaterThan(0);
      expect(
        actors.filter(
          (a) => !['kind,operatorId', 'id,kind'].includes(Object.keys(a).sort().join())
        ),
        `${copy}: an operator actor with more than kind and id`
      ).toEqual([]);
    }

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
  });
});
