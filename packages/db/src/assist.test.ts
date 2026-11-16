// The in-memory store partitions tenants by construction. This suite checks the new suggestion
// and consent tables under real forced RLS: an id copied from one site is unusable on another.

import { readFile } from 'node:fs/promises';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases, type Principal } from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7, uuidv7Ids } from './index.js';
import { requireDatabase, testTenant, migrateSchema } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');

describe.skipIf(skip)('assistance tenant isolation', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  const uow = createUnitOfWork(appDb, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
    assistProviderLabel: 'Fake model',
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix();
  let a = '';
  let b = '';

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    const tenant = async (slug: string) => (await testTenant(operatorDb, slug)).id;
    a = await tenant(`assist-a-${run}`);
    b = await tenant(`assist-b-${run}`);
  });
  afterAll(async () => {
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('keeps both consent and a suggestion inside the owning tenant', async () => {
    const pa = systemPrincipal(a, 'assist-test');
    const pb = systemPrincipal(b, 'assist-test');
    const created = await invoker.run(useCases.createItem, pa, {
      slug: `assist-${run}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Test' },
        blocks: [],
      },
    });
    const id = uuidv7();
    const requester = uuidv7();
    await uow.run(pa, async (ctx) => {
      await ctx.assist.saveSettings({
        enabled: true,
        allowRestricted: false,
        consentedProvider: 'Fake model',
        consentedBy: uuidv7(),
        consentedAt: new Date(),
      });
      await ctx.assist.insert({
        id,
        itemId: created.item.id,
        baseRevisionId: created.revision.id,
        task: 'alt',
        sourceBlockIds: [],
        blockId: 'photo',
        locale: 'nl',
        status: 'ready',
        value: 'Private suggestion',
        failure: null,
        provider: 'Fake model',
        requestedBy: requester,
        model: 'fake-vision',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    expect((await uow.run(pa, (ctx) => ctx.assist.get(id)))?.value).toBe('Private suggestion');
    expect(await uow.run(pb, (ctx) => ctx.assist.get(id))).toBeNull();
    const month = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    expect(await uow.run(pa, (ctx) => ctx.assist.countSince(month))).toBe(1);
    expect(await uow.run(pb, (ctx) => ctx.assist.countSince(month))).toBe(0);
    expect(
      await uow.run(pa, (ctx) =>
        ctx.assist.countByOperatorSince(requester, new Date(Date.now() - 3600000))
      )
    ).toBe(1);
    expect((await uow.run(pb, (ctx) => ctx.assist.settings())).enabled).toBe(false);
    const editorB: Principal = {
      ...pb,
      actor: { kind: 'operator', operatorId: uuidv7() },
      capabilities: ['content:read', 'content:write'],
    };
    await expect(
      invoker.run(useCases.getSuggestion, editorB, { suggestionId: id })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      invoker.run(useCases.acceptSuggestion, editorB, {
        suggestionId: id,
        baseRevisionId: created.revision.id,
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps lead and headline tasks per tenant, and 0065 types old rows by block id', async () => {
    const pa = systemPrincipal(a, 'assist-test');
    const pb = systemPrincipal(b, 'assist-test');
    const created = await invoker.run(useCases.createItem, pa, {
      slug: `assist-lead-${run}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'T' },
        blocks: [],
      },
    });
    const row = (id: string, task: 'alt' | 'translate' | 'lead' | 'headline', blockId: string) => ({
      id,
      itemId: created.item.id,
      baseRevisionId: created.revision.id,
      task,
      blockId,
      sourceBlockIds: task === 'lead' ? ['intro', 'body'] : [],
      locale: 'nl',
      status: 'pending' as const,
      value: null,
      failure: null,
      provider: 'Fake model',
      requestedBy: null,
      model: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const lead = uuidv7();
    await uow.run(pa, (ctx) => ctx.assist.insert(row(lead, 'lead', 'lead')));
    expect(await uow.run(pa, (ctx) => ctx.assist.get(lead))).toMatchObject({
      task: 'lead',
      blockId: 'lead',
      sourceBlockIds: ['intro', 'body'],
    });
    expect(await uow.run(pb, (ctx) => ctx.assist.get(lead))).toBeNull();
    // 0066: a headline row round-trips with its task and no source ids, also under RLS.
    const headline = uuidv7();
    await uow.run(pa, (ctx) => ctx.assist.insert(row(headline, 'headline', 'headline')));
    expect(await uow.run(pa, (ctx) => ctx.assist.get(headline))).toMatchObject({
      task: 'headline',
      blockId: 'headline',
      sourceBlockIds: [],
    });
    expect(await uow.run(pb, (ctx) => ctx.assist.get(headline))).toBeNull();
    expect(await uow.run(pb, (ctx) => ctx.assist.list(created.item.id))).toEqual([]);

    // Replay the 0065 backfill over rows written as before it (every row read as alt), inside a
    // transaction under tenant a's context that is rolled back.
    const migration = await readFile(
      new URL('../migrations/0065_assist_task.sql', import.meta.url),
      'utf8'
    );
    const backfill = /update assist_suggestions[^;]*;/.exec(migration)?.[0];
    expect(backfill).toBeDefined();
    const translation = uuidv7();
    const alt = uuidv7();
    const rollback = new Error('rollback');
    const seen = await appDb
      .transaction()
      .execute(async (trx) => {
        await sql`select set_config('app.tenant_id', ${a}, true)`.execute(trx);
        for (const [id, blockId] of [
          [translation, 'translate:{"from":"nl","to":"en","targets":["title"]}'],
          [alt, 'photo'],
        ] as const)
          await trx
            .insertInto('assist_suggestions')
            .values({
              id,
              tenant_id: a,
              item_id: created.item.id,
              base_revision_id: created.revision.id,
              task: 'alt',
              block_id: blockId,
              source_block_ids: [],
              locale: 'nl',
              status: 'failed',
              value: null,
              failure: 'rejected',
              provider: 'Fake model',
              requested_by: null,
              model: null,
              created_at: new Date(),
              updated_at: new Date(),
            })
            .execute();
        await sql.raw(backfill!).execute(trx);
        const rows = await trx
          .selectFrom('assist_suggestions')
          .select(['id', 'task'])
          .where('id', 'in', [translation, alt, lead])
          .execute();
        throw Object.assign(rollback, { rows });
      })
      .catch((e: Error & { rows?: { id: string; task: string }[] }) => {
        if (e !== rollback) throw e;
        return Object.fromEntries((e.rows ?? []).map((r) => [r.id, r.task]));
      });
    expect(seen).toEqual({ [translation]: 'translate', [alt]: 'alt', [lead]: 'lead' });
    expect(await uow.run(pa, (ctx) => ctx.assist.get(translation))).toBeNull();
  });
});
