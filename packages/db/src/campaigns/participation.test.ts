// Participation and the counter through Postgres (0049, 0051; ADR 033 rules 3, 7 and 8, #47 B2):
// the share lock and refusal on the submit path, the participation row written at ingest under
// the app role, withdrawal and renewal on the same row, and the erasure moving rows into the
// anonymous count. packages/core/src/campaigns/participation.test.ts holds every case in memory.
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  Invoker,
  buildRegistry,
  signConfirmToken,
  supporterIngestSubscriber,
  systemPrincipal,
  useCases,
  type Principal,
} from '@mycel/core';
import {
  FakeClock,
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  MemoryLogger,
  adminOf,
  expectCode,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { applyErasures, createDb, createUnitOfWork, readOutboxEvent, uuidv7Ids } from '../index.js';
import { asRole } from '../infra/roles.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from '../testing.js';

const { skip, operator, app } = requireDatabase('app');
const HOUR = 3600_000;

describe.skipIf(skip)('campaign participation through Postgres', () => {
  const owner = createDb(operator);
  const db = createDb(app);
  const clock = new FakeClock();
  const signer = new FakeSigner();
  const uow = createUnitOfWork(db, {
    clock,
    log: new MemoryLogger(),
    ids: uuidv7Ids,
    signer,
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const ingest = supporterIngestSubscriber(uow);
  const run = runSuffix();
  let tenant = '';
  let admin: Principal;
  let formId = '';
  let list = '';
  let campaignId = '';

  /** Deliver this tenant's unprocessed outbox events to supporter ingest, as the worker would. */
  async function drain(): Promise<string[]> {
    const { rows } = await asRole(owner, 'mycel_worker', (trx) =>
      sql<{ id: string }>`
        select id from outbox where tenant_id = ${tenant} and processed_at is null
        order by id`.execute(trx)
    );
    const types: string[] = [];
    for (const { id } of rows) {
      const event = await readOutboxEvent(owner, id);
      if (!event) continue;
      if (ingest.types.includes(event.type)) {
        await ingest.handle(event);
        types.push(event.type);
      }
      await asRole(owner, 'mycel_worker', (trx) =>
        trx.updateTable('outbox').set({ processed_at: new Date() }).where('id', '=', id).execute()
      );
    }
    return types;
  }
  const sign = (email: string, consent = false) =>
    invoker.run(useCases.submitForm, admin, { formId, values: { email, consent }, locale: 'nl' });
  const confirm = async (submissionId: string) =>
    invoker.run(useCases.confirmSubscription, admin, {
      token: await signConfirmToken(signer, { tenantId: tenant, submissionId, list }, clock.now()),
    });
  const signAndConfirm = async (email: string, consent = false) => {
    const r = await sign(email, consent);
    if (r.status !== 'accepted') throw new Error(r.status);
    await drain();
    await confirm(r.submissionId);
    return { submissionId: r.submissionId, types: await drain() };
  };
  const count = async () =>
    (await invoker.run(useCases.getCampaign, admin, { campaignId })).participants;
  const supporterId = async (email: string) =>
    (await uow.run(systemPrincipal(tenant, 'test'), (ctx) => ctx.supporters.getProjection(email)))!
      .id;

  beforeAll(async () => {
    await migrateSchema(operator);
    tenant = (await testTenant(owner, `participation-${run}`)).id;
    admin = adminOf(tenant);
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug: 'teken',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Teken' },
        blocks: [],
      } as never,
    });
    const form = await invoker.run(useCases.createForm, admin, { kind: 'petition' });
    formId = form.id;
    list = form.list;
    const created = await invoker.run(useCases.createCampaign, admin, {
      kind: 'petition',
      landingItemId: item.id,
      formId,
    });
    campaignId = created.id;
    const opened = await invoker.run(useCases.openCampaign, admin, {
      campaignId,
      baseUpdatedAt: created.updatedAt,
    });
    // Open but unpublished: nothing to sign on yet.
    await expectCode(sign(`vroeg-${run}@example.org`), 'conflict', 'campaign.closed');
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
    expect(opened.participation.state).toBe('open');
  });
  afterAll(async () => {
    await closeTenantWork(owner, [tenant]);
    await db.destroy();
    await owner.destroy();
  });

  it('records one row per confirmed supporter, and none before confirmation', async () => {
    const r = await sign(`ada-${run}@example.org`);
    if (r.status !== 'accepted') throw new Error(r.status);
    expect(await drain()).toEqual([]);
    expect(await count()).toBe(0);
    await confirm(r.submissionId);
    expect(await drain()).toEqual(['petition.signed']);
    expect(await count()).toBe(1);
    expect(await confirm(r.submissionId)).toMatchObject({ status: 'already_confirmed' });
    expect(await drain()).toEqual([]);
    // A repost after the recipient limit: a new submission, still one participation.
    clock.advance(25 * HOUR);
    await signAndConfirm(`ada-${run}@example.org`);
    expect(await count()).toBe(1);
    // The primary key holds one row per supporter; the repost renewed nothing.
    const row = await uow.run(systemPrincipal(tenant, 'test'), async (ctx) =>
      ctx.campaigns.participation(campaignId, await supporterId(`ada-${run}@example.org`))
    );
    expect(row?.withdrawnAt).toBeNull();
  });

  it('withdraws and renews on the same row under the app role', async () => {
    const email = `bea-${run}@example.org`;
    await signAndConfirm(email);
    const before = await count();
    const id = await supporterId(email);
    const withdrawn = await invoker.run(useCases.withdrawParticipation, admin, {
      campaignId,
      supporterId: id,
    });
    expect(withdrawn).toMatchObject({ withdrawn: true, campaign: { participants: before - 1 } });
    clock.advance(25 * HOUR);
    const again = await signAndConfirm(email);
    expect(await count()).toBe(before);
    const row = await uow.run(systemPrincipal(tenant, 'test'), (ctx) =>
      ctx.campaigns.participation(campaignId, id)
    );
    expect(row).toMatchObject({ submissionId: again.submissionId, withdrawnAt: null });
  });

  it('keeps the count through an erasure, and recounting the rows gives it back', async () => {
    const email = `cor-${run}@example.org`;
    await signAndConfirm(email, true);
    const before = await count();
    await invoker.run(useCases.eraseSupporter, admin, { supporterId: await supporterId(email) });
    expect(await applyErasures(owner, tenant)).toBeGreaterThan(0);
    expect(await count()).toBe(before);
    // Recount from what is stored: active rows plus the anonymous count.
    const recount = await uow.run(systemPrincipal(tenant, 'test'), async (ctx) => {
      const stored = await ctx.campaigns.get(campaignId);
      const active = await ctx.campaigns.activeCounts([campaignId]);
      return (active.get(campaignId) ?? 0) + stored!.erasedCount;
    });
    expect(recount).toBe(before);
    expect(
      (await uow.run(systemPrincipal(tenant, 'test'), (ctx) => ctx.campaigns.get(campaignId)))!
        .erasedCount
    ).toBe(1);
  });

  it('refuses a submission once the campaign is closed', async () => {
    const current = await invoker.run(useCases.getCampaign, admin, { campaignId });
    await invoker.run(useCases.closeCampaign, admin, {
      campaignId,
      baseUpdatedAt: current.updatedAt,
    });
    await expectCode(sign(`laat-${run}@example.org`), 'conflict', 'campaign.closed');
  });
});
