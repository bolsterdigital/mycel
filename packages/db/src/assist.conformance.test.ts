// The in-memory store partitions tenants by construction. This suite checks the new suggestion
// and consent tables under real forced RLS: an id copied from one site is unusable on another.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases, type Principal } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createUnitOfWork, migrate, upsertTenant, uuidv7, uuidv7Ids } from './index.js';

const operatorUrl = process.env['DATABASE_URL'];
const appUrl = process.env['APP_DATABASE_URL'];
if (process.env['E2E_REQUIRED'] === '1' && (!operatorUrl || !appUrl))
  throw new Error('E2E_REQUIRED=1 but the database URLs are unset');

describe.skipIf(!operatorUrl || !appUrl)('assistance tenant isolation', () => {
  const operatorDb = createDb(operatorUrl ?? '');
  const appDb = createDb(appUrl ?? '');
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
  const run = Math.random().toString(36).slice(2, 8);
  let a = '';
  let b = '';

  beforeAll(async () => {
    await migrate(operatorUrl!, { log: () => {} });
    const tenant = async (slug: string) =>
      (
        await upsertTenant(
          operatorDb,
          { id: uuidv7(), slug, name: slug, defaultLocale: 'nl', locales: ['nl'] },
          { platformDomain: 'localhost' }
        )
      ).id;
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
      actor: { kind: 'operator', operatorId: uuidv7(), email: 'editor@probe.test' },
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
});
