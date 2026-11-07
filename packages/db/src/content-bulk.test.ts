// Postgres counterproof for bulk plans: persistent snapshots, complete immutable selections,
// tenant RLS and item-bound revision references. Memory cannot prove these database properties.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Invoker, buildRegistry, useCases } from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  adminOf,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7, uuidv7Ids, withTenant } from './index.js';
import { migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');
describe.skipIf(skip)('content bulk plan conformance', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const run = runSuffix();
  const uow = createUnitOfWork(appDb, {
    clock: new FakeClock(),
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  let tenantA = '';
  let tenantB = '';
  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenantA = (await testTenant(operatorDb, `bulk-a-${run}`)).id;
    tenantB = (await testTenant(operatorDb, `bulk-b-${run}`)).id;
  });
  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });
  const create = (tenant = tenantA) =>
    invoker.run(useCases.createItem, adminOf(tenant), {
      document: {
        type: 'page',
        title: { nl: 'Original' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [],
      },
    });
  const prepare = async () => {
    const original = await create();
    const plan = await invoker.run(useCases.createBulk, adminOf(tenantA), {
      locale: 'nl',
      items: [
        {
          itemId: original.item.id,
          baseRevisionId: original.revision.id,
          operation: {
            kind: 'save',
            document: { ...original.revision.document, title: { nl: 'New' } },
          },
        },
      ],
    });
    return { plan, original };
  };

  it('persists a frozen proposal after later saves, with no content or job effect', async () => {
    const { plan, original } = await prepare();
    expect(plan.items[0]?.preview).toMatchObject({
      status: 'ready',
      changes: [{ path: 'title.nl', before: 'Original', after: 'New' }],
    });
    expect(
      (await invoker.run(useCases.listRevisions, adminOf(tenantA), { itemId: original.item.id }))
        .revisions
    ).toHaveLength(1);
    const jobs = await operatorDb
      .selectFrom('jobs')
      .selectAll()
      .where('tenant_id', '=', tenantA)
      .execute();
    expect(jobs).toEqual([]);
    await invoker.run(useCases.updateItem, adminOf(tenantA), {
      itemId: original.item.id,
      baseRevisionId: original.revision.id,
      document: { ...original.revision.document, title: { nl: 'Later' } },
    });
    expect(await invoker.run(useCases.getBulk, adminOf(tenantA), { planId: plan.id })).toEqual(
      plan
    );
  });

  it('hides plans through RLS and refuses cross-tenant/item revision pointers', async () => {
    const { plan } = await prepare();
    await expect(
      invoker.run(useCases.getBulk, adminOf(tenantB), { planId: plan.id })
    ).rejects.toMatchObject({ code: 'not_found' });
    const hidden = await withTenant(appDb, adminOf(tenantB), (trx) =>
      trx.selectFrom('content_bulk_plan_items').selectAll().where('plan_id', '=', plan.id).execute()
    );
    expect(hidden).toEqual([]);
    const foreign = await create(tenantB);
    const badPlan = await invoker.run(useCases.createBulk, adminOf(tenantA), {
      locale: 'nl',
      items: [
        {
          itemId: foreign.item.id,
          baseRevisionId: foreign.revision.id,
          operation: { kind: 'unpublish' },
        },
      ],
    });
    expect(badPlan.items[0]).toMatchObject({
      resolvedItemId: null,
      preview: { status: 'refused', problems: [{ code: 'not_found' }] },
    });
    const own = await create();
    await expect(
      withTenant(appDb, adminOf(tenantA), async (trx) => {
        const id = uuidv7();
        await trx
          .insertInto('content_bulk_plans')
          .values({
            tenant_id: tenantA,
            id,
            item_count: 1,
            version: 1,
            actor: '{}',
            locale: 'nl',
            created_at: new Date(),
          })
          .execute();
        await sql`insert into content_bulk_plan_items
        (tenant_id, plan_id, plan_size, ordinal, requested_item_id, item_id, base_revision_id, latest_revision_id, selection, publication, preview)
        values (${tenantA}, ${id}, 1, 0, ${own.item.id}, ${own.item.id}, ${foreign.revision.id}, ${own.revision.id}, '{}', '[]', '{}')`.execute(
          trx
        );
      })
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('cannot modify, delete, append to, or commit an incomplete plan', async () => {
    const { plan } = await prepare();
    for (const table of ['content_bulk_plans', 'content_bulk_plan_items'] as const) {
      await expect(
        withTenant(appDb, adminOf(tenantA), (trx) =>
          sql`update ${sql.table(table)} set tenant_id = ${tenantA}`.execute(trx)
        )
      ).rejects.toMatchObject({ code: '42501' });
      await expect(
        withTenant(appDb, adminOf(tenantA), (trx) => trx.deleteFrom(table).execute())
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      withTenant(appDb, adminOf(tenantA), (trx) =>
        sql`insert into content_bulk_plan_items
      select tenant_id, plan_id, plan_size, 1, ${uuidv7()}::uuid, item_id, base_revision_id, latest_revision_id, selection, publication, preview
      from content_bulk_plan_items where plan_id = ${plan.id}`.execute(trx)
      )
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withTenant(appDb, adminOf(tenantA), (trx) =>
        trx
          .insertInto('content_bulk_plans')
          .values({
            tenant_id: tenantA,
            id: uuidv7(),
            item_count: 1,
            version: 1,
            actor: '{}',
            locale: 'nl',
            created_at: new Date(),
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: '23514' });
  });
});
