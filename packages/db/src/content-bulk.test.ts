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

// The same adapter must commit a phase receipt with its mutation, even if its caller never
// receives the answer. These are real transactions; the memory adapter cannot prove rollback.
describe.skipIf(skip)('content bulk effects over Postgres', () => {
  const owner = createDb(operatorUrl);
  const app = createDb(appUrl);
  const clock = new FakeClock();
  const uow = createUnitOfWork(app, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const registry = buildRegistry();
  const invoker = new Invoker(registry, uow);
  let tenant = '';
  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    tenant = (await testTenant(owner, `bulk-effects-${runSuffix()}`)).id;
  });
  afterAll(async () => {
    await app.destroy();
    await owner.destroy();
  });
  async function prepare() {
    const original = await invoker.run(useCases.createItem, adminOf(tenant), {
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: `Item ${uuidv7()}` },
        blocks: [],
      },
    });
    const plan = await invoker.run(useCases.createBulk, adminOf(tenant), {
      locale: 'nl',
      items: [
        {
          itemId: original.item.id,
          baseRevisionId: original.revision.id,
          operation: {
            kind: 'save',
            document: { ...original.revision.document, lead: { nl: 'Bulk lead' } },
            publish: true,
          },
        },
      ],
    });
    return { original, plan, input: { planId: plan.id, version: 1 as const } };
  }
  it('serialises two clients, commits one receipt per phase and survives a lost response', async () => {
    const { original, plan, input } = await prepare();
    const [a, b] = await Promise.all([
      invoker.run(useCases.resumeBulk, adminOf(tenant), input),
      new Invoker(registry, uow).run(useCases.resumeBulk, adminOf(tenant), input),
    ]);
    expect(a).toEqual(b);
    expect(a.result.status).toBe('changed');
    let lose = true;
    const disconnected = new Invoker(registry, {
      async run(p, fn) {
        const answer = await uow.run(p, fn);
        if (lose) {
          lose = false;
          throw new Error('lost committed response');
        }
        return answer;
      },
    });
    await expect(disconnected.run(useCases.withdrawBulk, adminOf(tenant), input)).rejects.toThrow(
      'lost committed response'
    );
    const undo = await invoker.run(useCases.withdrawBulk, adminOf(tenant), input);
    expect(undo.result.status).toBe('undone');
    expect(
      (await invoker.run(useCases.listRevisions, adminOf(tenant), { itemId: original.item.id }))
        .revisions
    ).toHaveLength(3);
    const rows = await owner
      .selectFrom('content_bulk_effects')
      .selectAll()
      .where('plan_id', '=', plan.id)
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.phase).sort()).toEqual(['apply', 'undo']);
    expect(
      (await invoker.run(useCases.checkBulk, adminOf(tenant), { planId: plan.id })).fullyUndone
    ).toBe(true);
    const hidden = await withTenant(app, adminOf(uuidv7()), (trx) =>
      trx.selectFrom('content_bulk_effects').selectAll().where('plan_id', '=', plan.id).execute()
    );
    expect(hidden).toEqual([]);
  });
  it('rolls back a failure after mutation but before recording, then safely resumes', async () => {
    const { original, input } = await prepare();
    let crash = true;
    const failing = new Invoker(registry, {
      run(p, fn) {
        return uow.run(p, (ctx) =>
          fn({
            ...ctx,
            bulkPlans: {
              ...ctx.bulkPlans,
              async record(...args) {
                await ctx.bulkPlans.record(...args);
                if (crash) {
                  crash = false;
                  throw new Error('crash before commit');
                }
              },
            },
          })
        );
      },
    });
    await expect(failing.run(useCases.resumeBulk, adminOf(tenant), input)).rejects.toThrow(
      'crash before commit'
    );
    expect(
      (await invoker.run(useCases.getItem, adminOf(tenant), { itemId: original.item.id })).revision
        .id
    ).toBe(original.revision.id);
    expect(
      (await invoker.run(useCases.checkBulk, adminOf(tenant), { planId: input.planId })).items[0]
        ?.apply
    ).toBeNull();
    const applied = await invoker.run(useCases.resumeBulk, adminOf(tenant), input);
    expect(applied.result.status).toBe('changed');
    // A failed undo transaction also leaves the saved content and original receipt intact.
    crash = true;
    await expect(failing.run(useCases.withdrawBulk, adminOf(tenant), input)).rejects.toThrow(
      'crash before commit'
    );
    expect(
      (await invoker.run(useCases.getItem, adminOf(tenant), { itemId: original.item.id })).revision
        .id
    ).toBe(applied.result.savedRevisionId);
    expect((await invoker.run(useCases.withdrawBulk, adminOf(tenant), input)).result.status).toBe(
      'undone'
    );
  });
  it('holds the content lock across the publication check and pointer write', async () => {
    const { original, input } = await prepare();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let block = true;
    const held = new Invoker(registry, {
      run(p, fn) {
        return uow.run(p, (ctx) =>
          fn({
            ...ctx,
            content: {
              ...ctx.content,
              async save(item) {
                // writeRevision's first save precedes the publication pointer update.
                if (block) {
                  block = false;
                  entered();
                  await gate;
                }
                return ctx.content.save(item);
              },
            },
          })
        );
      },
    });
    const applying = held.run(useCases.resumeBulk, adminOf(tenant), input);
    await ready;
    const colleague = invoker.run(useCases.updateItem, adminOf(tenant), {
      itemId: original.item.id,
      baseRevisionId: original.revision.id,
      document: {
        ...original.revision.document,
        title: { nl: 'Colleague after publication check' },
      },
    });
    release();
    const [applied, edited] = await Promise.all([applying, colleague]);
    const item = (
      await invoker.run(useCases.getItem, adminOf(tenant), { itemId: original.item.id })
    ).item;
    expect(item.latestRevisionId).toBe(edited.revision.id);
    expect(item.publication[0]?.publishedRevisionId).toBe(applied.result.savedRevisionId);
    expect(item.publication[0]?.hasUnpublishedChanges).toBe(true);
    expect((await invoker.run(useCases.withdrawBulk, adminOf(tenant), input)).result.status).toBe(
      'conflict'
    );
  });
});
