// The public campaign projection a card renders from (ADR 033 rules 4, 6 and 8) over the memory
// adapter: every reason a card shows nothing, the participation phase at the moment of reading,
// the form only while open, the count with and without a public counter, and the live reference
// (a newer landing revision shows without touching the host). The save rule for a card's
// reference and the archive refusal it causes are here too. The renderer's side is
// `apps/web/src/lib/blocks/resolve.test.ts`; Postgres and RLS are `packages/db`.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { FakeClock, MemoryUnitOfWork, TENANT, expectCode, principal } from '../testing/index.js';
import { exampleId } from '../util/ids.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { landingCampaignOf } from './card.js';
import { visibleTarget } from './model.js';

const TENANT_B = exampleId(0xbbbb);
const HOUR = 3_600_000;

function setup() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const caps = ['content:read', 'content:write', 'content:publish', 'forms:write'] as const;
  const admin = principal({ capabilities: [...caps] });
  const other = principal({ capabilities: [...caps], tenantId: TENANT_B });
  const reader = principal({ capabilities: ['content:read'] });
  const start = (p = admin, slug = 'teken') =>
    invoker.run(useCases.composeCampaign, p, {
      kind: 'petition',
      title: { nl: 'Red het park', en: 'Save the park' },
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      slug,
      goal: { target: 500, milestones: [] },
    });
  const publish = async (itemId: string, locale: string, p = admin) => {
    const { item } = await invoker.run(useCases.getItem, p, { itemId });
    return invoker.run(useCases.publishItem, p, {
      itemId,
      revisionId: item.latestRevisionId,
      locale,
    });
  };
  const card = (campaignId: string, locale = 'nl', p = reader) =>
    invoker.run(useCases.getCampaignCard, p, { campaignId, locale });
  const current = (campaignId: string) => invoker.run(useCases.getCampaign, admin, { campaignId });
  return { clock, uow, invoker, admin, other, reader, start, publish, card, current };
}

describe('campaign.card.get (ADR 033 rule 4)', () => {
  it('says why a card shows nothing: unknown, another tenant, draft, other locale, archived', async () => {
    const { invoker, admin, other, start, publish, card, current } = setup();
    expect(await card(exampleId(0x404))).toEqual({
      available: false,
      campaignId: exampleId(0x404),
      reason: 'unknown',
    });
    const theirs = await start(other);
    await publish(theirs.landingItemId, 'nl', other);
    expect(await card(theirs.id)).toMatchObject({ available: false, reason: 'unknown' });

    const c = await start();
    expect(await card(c.id)).toMatchObject({ available: false, reason: 'draft' });
    await publish(c.landingItemId, 'nl');
    expect(await card(c.id, 'en')).toMatchObject({
      available: false,
      reason: 'locale-unpublished',
    });
    expect(await card(c.id, 'nl')).toMatchObject({ available: true });

    await invoker.run(useCases.archiveCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
    });
    expect(await card(c.id)).toMatchObject({ available: false, reason: 'archived' });
    // Archived first, then the page in the trash: still archived, the stronger reason.
    await invoker.run(useCases.deleteItem, admin, { itemId: c.landingItemId });
    expect(await card(c.id)).toMatchObject({ available: false, reason: 'archived' });
  });

  it('reads the landing page as published: featured title and lead, revision, image', async () => {
    const { invoker, admin, start, publish, card } = setup();
    const c = await start();
    const { revision } = await invoker.run(useCases.getItem, admin, { itemId: c.landingItemId });
    await invoker.run(useCases.updateItem, admin, {
      itemId: c.landingItemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        lead: { nl: 'Teken voor het park.', en: 'Sign for the park.' },
      },
    });
    const published = await publish(c.landingItemId, 'nl');
    const shown = await card(c.id);
    expect(shown).toMatchObject({
      available: true,
      kind: 'petition',
      locale: 'nl',
      landing: {
        id: c.landingItemId,
        type: 'page',
        slug: 'teken',
        revisionId: published.publication.find((p) => p.locale === 'nl')!.publishedRevisionId,
        title: 'Red het park',
        summary: 'Teken voor het park.',
        imageId: null,
      },
      counter: { participants: 0, target: 500 },
    });

    // A newer draft of the landing page shows nothing until it is published; then it does,
    // without anything happening to a page that holds the card (no pin, rule 4).
    const latest = await invoker.run(useCases.getItem, admin, { itemId: c.landingItemId });
    await invoker.run(useCases.updateItem, admin, {
      itemId: c.landingItemId,
      baseRevisionId: latest.revision.id,
      document: { ...latest.revision.document, title: { nl: 'Red het stadspark', en: 'Park' } },
    });
    expect(await card(c.id)).toMatchObject({ landing: { title: 'Red het park' } });
    await publish(c.landingItemId, 'nl');
    const after = await card(c.id);
    expect(after).toMatchObject({ landing: { title: 'Red het stadspark' } });
    if (!after.available || !shown.available) throw new Error('unreachable');
    expect(after.landing.revisionId).not.toBe(shown.landing.revisionId);
  });

  it('carries the text blocks of the same revision as the body, and says when more is left out', async () => {
    const { invoker, admin, start, publish, card } = setup();
    const c = await start();
    expect(await publish(c.landingItemId, 'nl')).toBeTruthy();
    // No blocks yet: no body, not an empty one.
    expect(await card(c.id)).toMatchObject({ landing: { body: null } });

    const para = (nl: string) => ({
      type: 'doc' as const,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: nl }] }],
    });
    const { revision } = await invoker.run(useCases.getItem, admin, { itemId: c.landingItemId });
    await invoker.run(useCases.updateItem, admin, {
      itemId: c.landingItemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        blocks: [
          { id: 'kop', type: 'heading', version: 1, props: { text: { nl: 'Wij constateren' } } },
          {
            id: 'tekst',
            type: 'rich-text',
            version: 1,
            props: { content: { nl: para('Het park verdwijnt.') } },
          },
          {
            id: 'meer',
            type: 'cta',
            version: 1,
            props: {
              title: { nl: 'Meer' },
              actions: [{ label: { nl: 'Lees' }, target: { kind: 'url', url: '/meer' } }],
            },
          },
        ],
      },
    });
    await publish(c.landingItemId, 'nl');
    const shown = await card(c.id);
    if (!shown.available) throw new Error('unreachable');
    expect(shown.landing.body?.blocks.map((b) => b.id)).toEqual(['kop', 'tekst']);
    expect(shown.landing.body?.more).toBe(true);
  });

  it('gives the phase now and the form only while participation is open', async () => {
    const { clock, invoker, admin, start, publish, card, current } = setup();
    const c = await start();
    await publish(c.landingItemId, 'nl');
    expect(await card(c.id)).toMatchObject({ phase: 'upcoming', formId: null });

    await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
      window: {
        opensAt: new Date(clock.now().getTime() + HOUR).toISOString(),
        closesAt: new Date(clock.now().getTime() + 3 * HOUR).toISOString(),
      },
    });
    await invoker.run(useCases.openCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
    });
    // Open, but before its window: not yet, evaluated when read (ADR 019 rule 4).
    expect(await card(c.id)).toMatchObject({ phase: 'upcoming', formId: null });
    clock.advance(2 * HOUR);
    expect(await card(c.id)).toMatchObject({ phase: 'open', formId: c.formId });
    clock.advance(2 * HOUR);
    expect(await card(c.id)).toMatchObject({ phase: 'closed', formId: null });

    await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
      window: { opensAt: null, closesAt: null },
    });
    expect(await card(c.id)).toMatchObject({ phase: 'open' });
    await invoker.run(useCases.closeCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
    });
    expect(await card(c.id)).toMatchObject({ phase: 'closed', formId: null });
  });

  it('counts confirmed participants plus erased ones, and shows no number when hidden', async () => {
    const { uow, invoker, admin, start, publish, card, current } = setup();
    const c = await start();
    await publish(c.landingItemId, 'nl');
    await uow.run(admin, async (ctx) => {
      for (const n of [1, 2])
        await ctx.campaigns.recordParticipation({
          campaignId: c.id,
          supporterId: exampleId(0x5000 + n),
          submissionId: exampleId(0x6000 + n),
          confirmedAt: ctx.clock.now().toISOString(),
        });
    });
    expect(await card(c.id)).toMatchObject({ counter: { participants: 2, target: 500 } });
    await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
      counterVisible: false,
    });
    expect(await card(c.id)).toMatchObject({ available: true, counter: null });
  });
});

describe('a goal that grows with the count (MY-288)', () => {
  const growing = { target: 1000, milestones: [100, 500] };
  it('shows each milestone until 95 % of it, a jump passes several, the target stays at the end', () => {
    expect(visibleTarget(growing, 0)).toBe(100);
    expect(visibleTarget(growing, 94)).toBe(100);
    expect(visibleTarget(growing, 95)).toBe(500);
    expect(visibleTarget(growing, 474)).toBe(500);
    expect(visibleTarget(growing, 475)).toBe(1000);
    expect(visibleTarget(growing, 1200)).toBe(1000);
    // A fixed goal keeps its target; no goal shows none.
    expect(visibleTarget({ target: 500, milestones: [] }, 480)).toBe(500);
    expect(visibleTarget(null, 480)).toBeNull();
  });

  it('gives the card and the landing page the same count and goal, and hides both when hidden', async () => {
    const { uow, invoker, admin, start, publish, card, current } = setup();
    const c = await start();
    await publish(c.landingItemId, 'nl');
    await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
      goal: growing,
    });
    let signed = 0;
    const signTo = (n: number) =>
      uow.run(admin, async (ctx) => {
        for (; signed < n; signed++)
          await ctx.campaigns.recordParticipation({
            campaignId: c.id,
            supporterId: exampleId(0x50000 + signed),
            submissionId: exampleId(0x60000 + signed),
            confirmedAt: ctx.clock.now().toISOString(),
          });
      });
    const landing = () => uow.run(admin, (ctx) => landingCampaignOf(ctx, c.landingItemId));
    for (const [count, target] of [
      [94, 100],
      [95, 500],
      [480, 1000],
      [1001, 1000],
    ] as const) {
      await signTo(count);
      expect(await card(c.id), `card at ${count}`).toMatchObject({
        counter: { participants: count, target },
      });
      expect((await landing())!.counter, `landing at ${count}`).toMatchObject({
        participants: count,
        target,
      });
    }
    await invoker.run(useCases.updateCampaign, admin, {
      campaignId: c.id,
      baseUpdatedAt: (await current(c.id)).updatedAt,
      counterVisible: false,
    });
    expect(await card(c.id)).toMatchObject({ counter: null });
    expect((await landing())!.counter).toBeNull();
  });
});

describe('a campaign card in a document (ADR 033 rules 4, 9 and 10)', () => {
  const host = (campaignId: string) => ({
    type: 'page' as const,
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: 'Thuis' },
    blocks: [{ type: 'campaign-card' as const, version: 1 as const, props: { campaignId } }],
  });

  it("refuses an unknown or another site's campaign on save, like any unknown reference", async () => {
    const { invoker, admin, other, start } = setup();
    const theirs = await start(other);
    for (const id of [exampleId(0x404), theirs.id])
      await expectCode(
        invoker.run(useCases.createItem, admin, { slug: `x-${id.slice(-4)}`, document: host(id) }),
        'invalid_input',
        'content.reference.campaign-unknown'
      );
  });

  it('records the reference, so archiving is refused while a published page shows the card', async () => {
    const { invoker, admin, start, current } = setup();
    const c = await start();
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug: 'thuis',
      document: host(c.id),
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
    await expectCode(
      invoker.run(useCases.archiveCampaign, admin, {
        campaignId: c.id,
        baseUpdatedAt: (await current(c.id)).updatedAt,
      }),
      'conflict',
      'campaign.archive.referenced'
    );
    // Publishing the host published nothing of the campaign (rule 4).
    const landing = await invoker.run(useCases.getItem, admin, { itemId: c.landingItemId });
    expect(landing.item.publication.filter((p) => p.publishedRevisionId)).toEqual([]);
  });
});
