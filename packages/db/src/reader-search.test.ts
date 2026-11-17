// Site search with reader access against Postgres (migration 0073, ADR 016 rule 3, brief
// site-search § B): what the memory adapter cannot prove, because the access rule is stated a
// second time in SQL. A word that stands only behind a restricted item's boundary is found by a
// reader with a standing grant on its tier, by no visitor, no reader of another tier and no reader
// whose grant has ended; a members item opens to any signed-in reader. A visitor finds the item by
// its teaser, marked `restricted`, and no excerpt or title they get carries a word from behind
// the boundary. Another tenant's restricted item and an unpublished draft stay unfindable for a
// reader with every grant. The memory adapter runs the same rule in adapter-rules.test.ts.
//
// Skips without DATABASE_URL and APP_DATABASE_URL; in CI that is a failure.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Invoker,
  SupporterEvent,
  anonymousPrincipal,
  buildRegistry,
  ingest,
  readerPrincipal,
  systemPrincipal,
  useCases,
  type Principal,
  type UnitOfWork,
} from '@mycel/core';
import {
  FakeDns,
  FakeInputHasher,
  FakeSigner,
  memoryPlatform,
  runSuffix,
} from '@mycel/core/testing';
import { createDb, createUnitOfWork, uuidv7Ids } from './index.js';
import { closeTenantWork, migrateSchema, requireDatabase, testTenant } from './testing.js';

const { skip, operator: operatorUrl, app: appUrl } = requireDatabase('app');
const HOUR = 60 * 60 * 1000;

describe.skipIf(skip)('site search with reader access', () => {
  const operatorDb = createDb(operatorUrl);
  const appDb = createDb(appUrl);
  let ahead = 0;
  const clock = { now: () => new Date(Date.now() + ahead) };
  const uow: UnitOfWork = createUnitOfWork(appDb, {
    clock,
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  const invoker = new Invoker(buildRegistry(), uow);
  const run = runSuffix().replace(/\W/g, '');
  // Distinct words per run, so rows of earlier runs in the same database match nothing here.
  const TITLE = `kroniek${run}`;
  const TEASER = `vooraf${run}`;
  const SECRET = `binnenwerk${run}`;
  let a = '';
  let b = '';
  const admin = (tenant: string) => systemPrincipal(tenant, 'test');
  const visitor = (tenant: string) => anonymousPrincipal(tenant, ['content:read']);

  const paragraph = (id: string, text: string) => ({
    id,
    type: 'rich-text',
    version: 1,
    props: {
      content: {
        nl: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
      },
    },
  });

  async function article(
    tenant: string,
    slug: string,
    access: Record<string, unknown>,
    publish = true
  ) {
    const { item, revision } = await invoker.run(useCases.createItem, admin(tenant), {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: `${TITLE} ${slug}` },
        blocks: [
          paragraph('open', `Een ${TEASER} alinea.`),
          { id: 'wall', type: 'paywall', version: 1, props: {} },
          paragraph('body', `Het ${SECRET} besluit van ${slug}.`),
        ],
        access: { teaser: 'marker', ...access },
      } as never,
    });
    if (publish)
      await invoker.run(useCases.publishItem, admin(tenant), {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
    return item.id;
  }

  /** A supporter with an open reader session, as the web front holds it after a sign-in. */
  async function reader(tenant: string, email: string) {
    await uow.run(admin(tenant), (ctx) =>
      ingest(
        ctx,
        SupporterEvent.parse({
          schema: 'wings.supporter-event.v1',
          id: `seen-${run}-${tenant}-${email}`,
          type: 'newsletter.subscribed',
          email,
          occurred_at: clock.now().toISOString(),
          source: 'test',
          source_site: 'urn:mycel:test',
          source_ref: email,
          props: { list: 'news' },
        })
      )
    );
    const supporter = await invoker.run(useCases.getSupporter, admin(tenant), { email });
    const sessionId = uuidv7Ids.next();
    await uow.run(admin(tenant), (ctx) =>
      ctx.readerSessions.insert({
        id: sessionId,
        supporterId: supporter.id,
        createdAt: clock.now(),
        expiresAt: new Date(clock.now().getTime() + 12 * HOUR),
        revokedAt: null,
      })
    );
    return { supporterId: supporter.id, sessionId, as: readerPrincipal(tenant, sessionId) };
  }

  const grant = (tenant: string, supporterId: string, tierId: string, until?: Date) =>
    invoker.run(useCases.createAccessGrant, admin(tenant), {
      supporterId,
      tierId,
      kind: 'comp',
      reason: 'test',
      ...(until ? { until: until.toISOString() } : {}),
    });
  const tier = async (tenant: string, slug: string) =>
    (
      await invoker.run(useCases.createAccessTier, admin(tenant), {
        slug: `${slug}-${run}`.slice(0, 60),
        name: { nl: slug },
      })
    ).id;
  const find = (as: Principal, q: string) =>
    invoker.run(useCases.findPublished, as, { q, locale: 'nl' });
  const slugs = async (as: Principal, q: string) =>
    (await find(as, q)).items.map((r) => r.slug).sort();

  let donateurs = '';
  let pers = '';
  let withTier: Principal;
  let otherTier: Principal;
  let noGrant: Principal;
  let ended: Principal;
  let everyGrantB: Principal;
  let sessionB = '';

  beforeAll(async () => {
    await migrateSchema(operatorUrl);
    a = (await testTenant(operatorDb, `rsearch-a-${run}`)).id;
    b = (await testTenant(operatorDb, `rsearch-b-${run}`)).id;
    donateurs = await tier(a, 'donateurs');
    pers = await tier(a, 'pers');
    await article(a, 'donateurs', { level: 'tier', tierIds: [donateurs] });
    await article(a, 'leden', { level: 'members' });
    await article(a, 'concept', { level: 'members' }, false);
    const tierB = await tier(b, 'donateurs');
    await article(b, 'elders', { level: 'tier', tierIds: [tierB] });

    const ada = await reader(a, `ada-${run}@example.org`);
    await grant(a, ada.supporterId, donateurs);
    withTier = ada.as;
    const bo = await reader(a, `bo-${run}@example.org`);
    await grant(a, bo.supporterId, pers);
    otherTier = bo.as;
    noGrant = (await reader(a, `cas-${run}@example.org`)).as;
    const dee = await reader(a, `dee-${run}@example.org`);
    await grant(a, dee.supporterId, donateurs, new Date(clock.now().getTime() + HOUR));
    ended = dee.as;
    const eli = await reader(b, `eli-${run}@example.org`);
    await grant(b, eli.supporterId, tierB);
    everyGrantB = eli.as;
    sessionB = eli.sessionId;
  });

  afterAll(async () => {
    await closeTenantWork(operatorDb, [a, b]);
    await operatorDb.destroy();
    await appDb.destroy();
  });

  it('finds a word behind the boundary only for a reader whose grant opens the item', async () => {
    expect(await slugs(visitor(a), SECRET)).toEqual([]);
    expect(await slugs(admin(a), SECRET)).toEqual([]);
    expect(await slugs(otherTier, SECRET)).toEqual(['leden']);
    expect(await slugs(noGrant, SECRET)).toEqual(['leden']);
    expect(await slugs(withTier, SECRET)).toEqual(['donateurs', 'leden']);
    // The excerpt of a reader with access comes from the body.
    const hit = (await find(withTier, SECRET)).items.find((r) => r.slug === 'donateurs')!;
    expect(hit.restricted).toBe(true);
    expect(hit.excerpt.filter((s) => s.match).map((s) => s.text)).toEqual([SECRET]);
  });

  it('matches the body in the index itself only for the tiers a reader stands in', async () => {
    // The use case decides a second time, so this asks the adapter alone: the SQL rule must hold
    // without it, or a page of hits shrinks and its `next` tells what words a body holds.
    const indexed = (reader: { tierIds: string[] } | null) =>
      uow.run(visitor(a), async (ctx) =>
        (await ctx.content.searchPublished({ tokens: [SECRET], locale: 'nl', reader }, 0, 10))
          .map((h) => h.slug)
          .sort()
      );
    expect(await indexed(null)).toEqual([]);
    expect(await indexed({ tierIds: [] })).toEqual(['leden']);
    expect(await indexed({ tierIds: [pers] })).toEqual(['leden']);
    expect(await indexed({ tierIds: [pers, donateurs] })).toEqual(['donateurs', 'leden']);
  });

  it('closes the body at the end of a grant, in a session that is still open', async () => {
    expect(await slugs(ended, SECRET)).toEqual(['donateurs', 'leden']);
    ahead = HOUR;
    try {
      expect(await slugs(ended, SECRET)).toEqual(['leden']);
    } finally {
      ahead = 0;
    }
  });

  it('shows everyone else the teaser, marked, with nothing from behind the boundary', async () => {
    for (const as of [visitor(a), otherTier]) {
      const answer = await find(as, TEASER);
      expect(answer.items.map((r) => r.slug).sort()).toEqual(['donateurs', 'leden'].sort());
      const leden = answer.items.find((r) => r.slug === 'leden')!;
      if (as === otherTier) {
        // A signed-in reader opens a members item; only the tier item stays a teaser.
        expect(JSON.stringify(leden)).toContain(TEASER);
      }
      const donateurs = answer.items.find((r) => r.slug === 'donateurs')!;
      expect(donateurs.restricted).toBe(true);
      expect(JSON.stringify(donateurs)).not.toContain(SECRET);
      expect(donateurs.excerpt.map((s) => s.text).join('')).toBe(`Een ${TEASER} alinea.`);
    }
    expect(JSON.stringify(await find(visitor(a), TITLE))).not.toContain(SECRET);
  });

  it('keeps another tenant and a draft out, whatever the reader holds', async () => {
    expect(await slugs(withTier, TITLE)).toEqual(['donateurs', 'leden']);
    expect(await slugs(everyGrantB, SECRET)).toEqual(['elders']);
    // A session of b names no reader in a, so it searches a as a visitor.
    expect(await slugs(readerPrincipal(a, sessionB), SECRET)).toEqual([]);
    expect(await slugs(withTier, `${SECRET} elders`)).toEqual([]);
    expect(await slugs(visitor(b), SECRET)).toEqual([]);
  });
});
