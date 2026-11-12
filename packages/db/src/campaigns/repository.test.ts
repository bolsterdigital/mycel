// Campaigns through Postgres (0049, ADR 033): the use cases over the real adapter, the binding
// keys as a backstop under the use-case locks, the archive refusal over `content_block_refs`, and
// the tenant boundary under forced RLS. packages/core/src/campaigns/service.test.ts holds every
// refusal over the memory adapter.
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { Invoker, buildRegistry, useCases, type Principal } from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryLogger,
  adminOf,
  expectCode,
  memoryPlatform,
  principal,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from '../index.js';
import { asRole } from '../infra/roles.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator, app } = requireDatabase('app');

describe.skipIf(skip)('campaigns through Postgres', () => {
  const owner = createDb(operator);
  const db = createDb(app);
  const uow = createUnitOfWork(db, {
    clock: new FakeClock(),
    log: new MemoryLogger(),
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  let tenant = '';
  let foreign = '';
  let admin: Principal;
  const page = (p: Principal, slug: string, access?: unknown) =>
    invoker.run(useCases.createItem, p, {
      slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: slug },
        blocks: [],
        ...(access ? { access } : {}),
      } as never,
    });

  beforeAll(async () => {
    await migrateSchema(operator);
    const run = runSuffix();
    tenant = (await testTenant(owner, `campaigns-${run}`)).id;
    foreign = (await testTenant(owner, `campaigns-other-${run}`)).id;
    admin = adminOf(tenant);
  });
  afterAll(async () => {
    await closeTenantWork(owner, [tenant, foreign]);
    await db.destroy();
    await owner.destroy();
  });

  it('creates, moves the window, opens, closes and archives on the stored row', async () => {
    const landing = await page(admin, 'teken');
    const form = await invoker.run(useCases.createForm, admin, { kind: 'petition' });
    const created = await invoker.run(useCases.createCampaign, admin, {
      kind: 'petition',
      landingItemId: landing.item.id,
      formId: form.id,
      goal: { target: 500, milestones: [100] },
    });
    expect(await invoker.run(useCases.getCampaign, admin, { campaignId: created.id })).toEqual(
      created
    );
    const window = { opensAt: '2026-12-01T00:00:00.000Z', closesAt: '2027-01-01T00:00:00.000Z' };
    const moved = await invoker.run(useCases.updateCampaign, admin, {
      campaignId: created.id,
      baseUpdatedAt: created.updatedAt,
      window,
      counterVisible: false,
    });
    expect(moved).toMatchObject({
      counterVisible: false,
      participation: { state: 'draft', ...window },
    });
    await expectCode(
      invoker.run(useCases.updateCampaign, admin, {
        campaignId: created.id,
        baseUpdatedAt: created.updatedAt,
        counterVisible: true,
      }),
      'conflict',
      'campaign.conflict'
    );
    const opened = await invoker.run(useCases.openCampaign, admin, {
      campaignId: created.id,
      baseUpdatedAt: moved.updatedAt,
    });
    const writer = principal({
      tenantId: tenant,
      capabilities: ['content:read', 'content:write', 'forms:write'],
    });
    await expectCode(
      invoker.run(useCases.closeCampaign, writer, {
        campaignId: created.id,
        baseUpdatedAt: opened.updatedAt,
      }),
      'forbidden'
    );
    const closed = await invoker.run(useCases.closeCampaign, admin, {
      campaignId: created.id,
      baseUpdatedAt: opened.updatedAt,
    });
    const archived = await invoker.run(useCases.archiveCampaign, admin, {
      campaignId: created.id,
      baseUpdatedAt: closed.updatedAt,
    });
    expect(archived).toMatchObject({ participation: { state: 'closed' }, erasedCount: 0 });
    expect(archived.archivedAt).not.toBeNull();
    const { campaigns } = await invoker.run(useCases.listCampaigns, admin, { archived: true });
    expect(campaigns.map((c) => c.id)).toContain(created.id);
    expect(
      (await invoker.run(useCases.listCampaigns, admin, {})).campaigns.map((c) => c.id)
    ).not.toContain(created.id);
  });

  it('holds the landing page public and out of the trash while bound', async () => {
    const landing = await page(admin, 'blijft');
    const c = await invoker.run(useCases.createCampaign, admin, {
      kind: 'signup',
      landingItemId: landing.item.id,
    });
    await expectCode(
      invoker.run(useCases.updateItem, admin, {
        itemId: landing.item.id,
        baseRevisionId: landing.revision.id,
        document: {
          ...landing.revision.document,
          access: { level: 'members', teaser: { blocks: 0 } },
        } as never,
      }),
      'conflict',
      'campaign.landing.restricted'
    );
    await expectCode(
      invoker.run(useCases.deleteItem, admin, { itemId: landing.item.id }),
      'conflict',
      'content.delete.campaign-landing'
    );
    // The key is the backstop under the item lock: a second row on the same page is refused.
    const twin = { ...c, id: uuidv7Ids.next(), formId: null };
    expect(await uow.run(admin, (ctx) => ctx.campaigns.insert(twin))).toBe(false);
    const closed = await page(admin, 'leden', { level: 'members', teaser: { blocks: 0 } });
    await expectCode(
      invoker.run(useCases.createCampaign, admin, {
        kind: 'signup',
        landingItemId: closed.item.id,
      }),
      'conflict',
      'campaign.landing.restricted'
    );
  });

  it('refuses to archive while a published revision holds a campaign reference', async () => {
    const landing = await page(admin, 'kaartdoel');
    const c = await invoker.run(useCases.createCampaign, admin, {
      kind: 'signup',
      landingItemId: landing.item.id,
    });
    const host = await page(admin, 'kaarthouder');
    // No block writes a campaign reference before the campaign card exists; write the row it will write.
    await asRole(owner, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${tenant}, true)`.execute(trx);
      await sql`insert into content_block_refs (tenant_id, item_id, revision_id, block_id, type, ref_id)
        values (${tenant}, ${host.item.id}, ${host.revision.id}, 'card', 'campaign', ${c.id})`.execute(
        trx
      );
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: host.item.id,
      revisionId: host.revision.id,
      locale: 'nl',
    });
    const at = { campaignId: c.id, baseUpdatedAt: c.updatedAt };
    const refused = await expectCode(
      invoker.run(useCases.archiveCampaign, admin, at),
      'conflict',
      'campaign.archive.referenced'
    );
    expect(refused.issues[0]?.params).toEqual({ count: '1', titles: 'kaarthouder' });
    await invoker.run(useCases.unpublishItem, admin, { itemId: host.item.id, locale: 'nl' });
    await invoker.run(useCases.archiveCampaign, admin, at);
  });

  it("keeps each tenant's campaigns, pages and forms to itself", async () => {
    const landing = await page(admin, 'grens');
    const form = await invoker.run(useCases.createForm, admin, { kind: 'signup' });
    const c = await invoker.run(useCases.createCampaign, admin, {
      kind: 'signup',
      landingItemId: landing.item.id,
      formId: form.id,
    });
    const other = adminOf(foreign);
    await expectCode(invoker.run(useCases.getCampaign, other, { campaignId: c.id }), 'not_found');
    expect((await invoker.run(useCases.listCampaigns, other, {})).campaigns).toEqual([]);
    await expectCode(
      invoker.run(useCases.createCampaign, other, {
        kind: 'signup',
        landingItemId: landing.item.id,
      }),
      'not_found'
    );
    const own = await page(other, 'eigen');
    await expectCode(
      invoker.run(useCases.createCampaign, other, {
        kind: 'signup',
        landingItemId: own.item.id,
        formId: form.id,
      }),
      'not_found'
    );
    // Under the other tenant's context, RLS shows no row of this one.
    const seen = await asRole(owner, 'mycel_app', async (trx) => {
      await sql`select set_config('app.tenant_id', ${foreign}, true)`.execute(trx);
      return (await sql<{ n: number }>`select count(*)::int as n from campaigns`.execute(trx))
        .rows[0]!.n;
    });
    expect(seen).toBe(0);
  });
});
