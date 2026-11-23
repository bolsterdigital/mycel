// Dreamkit campaigns through plan and execute on the memory adapter (MY-291, briefing "Done
// when"): each of the three kinds becomes one campaign on its landing page, two pages that show a
// card of one action show one campaign, a change to the landing reaches both cards, the old address
// and the archive of each kind are reported, and an imported campaign takes no part: it has no form
// and stays a draft, so opening it is refused until an editor binds one.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { MemoryUnitOfWork, TENANT } from '@mycel/core/testing';
import { execute } from './execute.js';
import { plan, placeholder, type ImportPlan } from './plan.js';
import { formatReport } from './report.js';

const XML = readFileSync(new URL('../fixtures/campaign-export.xml', import.meta.url), 'utf8');
const item = (p: ImportPlan, postId: number) =>
  p.items.find((i) => i.sources.some((s) => s.id === postId))!;
const lines = (p: ImportPlan, code: string) =>
  p.report.filter((l) => l.code === code).map((l) => `${l.postId ?? '-'} ${l.detail ?? ''}`.trim());
const cardsOf = (blocks: { type: string; props: unknown }[]) =>
  blocks.filter((b) => b.type === 'campaign-card').map((b) => b.props);

describe('Dreamkit campaigns (MY-291)', () => {
  const planned = plan(XML);
  const petition = placeholder('campaign', 701);

  it('makes each action a landing page and a campaign of its kind', () => {
    expect(planned.campaigns).toEqual([
      {
        ref: petition,
        sourceId: 701,
        landingRef: placeholder('item', 701),
        kind: 'petition',
        goal: { target: 1000, milestones: [] },
        startingCount: 120,
      },
      expect.objectContaining({ kind: 'signup', goal: { target: 50, milestones: [] } }),
      // A fundraiser's goal in cents; it has no starting count.
      expect.objectContaining({
        kind: 'fundraiser',
        goal: { target: 250_000, milestones: [] },
        startingCount: 0,
      }),
    ]);
    expect(item(planned, 701)).toMatchObject({ status: 'published', document: { type: 'page' } });
    expect(item(planned, 703)).toMatchObject({
      status: 'draft',
      document: { featuredImageId: placeholder('media', 101) },
    });
  });

  it('turns both cards of the petition into the same campaign and reports the missing one', () => {
    expect(cardsOf(item(planned, 801).document.blocks)).toEqual([
      { campaignId: petition, variant: 'full' },
    ]);
    expect(cardsOf(item(planned, 802).document.blocks)).toEqual([
      { campaignId: petition, variant: 'compact' },
    ]);
    expect(lines(planned, 'items.missing')).toEqual(['801 campaign 999']);
  });

  it('reports per action what stays at its source, and the old addresses', () => {
    expect(lines(planned, 'campaign.form-missing')).toEqual([
      '701 Gravity Forms form 5; bind a petition form',
      '702 no form; bind a signup form',
      '703 no form; bind a donation form',
    ]);
    expect(lines(planned, 'campaign.history-in-source')).toEqual([
      '701 participations (87 confirmed in the source); starting count 120',
      '702 participations',
      '703 gifts and payments; donor count offset 4 not used',
    ]);
    expect(lines(planned, 'campaign.confirmation')).toEqual([
      '701 source asked for confirmation',
      '702 source took part without confirmation',
    ]);
    expect(lines(planned, 'campaign.goal-milestones')).toEqual(['702 goal 50']);
    expect(lines(planned, 'item.slug-changed')).toContain(
      '701 https://voorbeeld.example/petitions/red-de-rivier/ → /red-de-rivier'
    );
    expect(lines(planned, 'campaign.archive')).toEqual([
      '- https://voorbeeld.example/petitions/ → the page with the index of petitions',
      '- https://voorbeeld.example/signups/ → the page with the index of signups',
      '- https://voorbeeld.example/fundraisers/ → the page with the index of fundraisers',
    ]);
  });

  it('lists a line without a post by its detail alone', () => {
    expect(formatReport(planned)).toContain(
      '\n  - https://voorbeeld.example/petitions/ → the page with the index of petitions\n'
    );
    expect(formatReport(planned)).toContain('Campaigns  3 (1 petition, 1 signup, 1 fundraiser)');
  });

  it('plans the same export the same way twice', () => {
    expect(plan(XML)).toEqual(planned);
  });

  it('imports one campaign per action that takes no part, and whose cards follow its page', async () => {
    const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());
    const principal = systemPrincipal(TENANT, 'importer');
    const result = await execute(planned, {
      invoker,
      principal,
      media: async () => ({ error: 'not needed' }),
    });
    expect(
      result.report.filter((l) => l.code.endsWith('failed') && l.code !== 'media.failed')
    ).toEqual([]);

    const { campaigns } = await invoker.run(useCases.listCampaigns, principal, {});
    expect(campaigns.map((c) => [c.kind, c.participation.state, c.formId])).toEqual(
      expect.arrayContaining([
        ['petition', 'draft', null],
        ['signup', 'draft', null],
        ['fundraiser', 'draft', null],
      ])
    );
    expect(campaigns).toHaveLength(3);
    const campaignId = result.ids[petition]!;
    const made = await invoker.run(useCases.getCampaign, principal, { campaignId });
    expect(made.participants).toBe(120);

    // An incomplete action cannot take part: without a form, opening is refused.
    await expect(
      invoker.run(useCases.openCampaign, principal, {
        campaignId,
        baseUpdatedAt: made.updatedAt,
      })
    ).rejects.toMatchObject({ code: 'conflict' });

    // Both pages show a card of the one campaign; a new title on its landing reaches both.
    const get = (slug: string) =>
      invoker.run(useCases.getPublished, principal, { type: 'page', slug });
    for (const slug of ['doe-mee', 'over-ons'])
      expect(cardsOf((await get(slug)).blocks)).toEqual([expect.objectContaining({ campaignId })]);
    const card = () =>
      invoker.run(useCases.getCampaignCard, principal, { campaignId, locale: 'nl' });
    expect(await card()).toMatchObject({ available: true, landing: { title: 'Red de rivier' } });

    const landingItemId = result.ids[placeholder('item', 701)]!;
    const current = await invoker.run(useCases.getItem, principal, { itemId: landingItemId });
    const saved = await invoker.run(useCases.updateItem, principal, {
      itemId: landingItemId,
      baseRevisionId: current.revision.id,
      document: { ...current.revision.document, title: { nl: 'Red de rivier nu' } },
    });
    await invoker.run(useCases.publishItem, principal, {
      itemId: landingItemId,
      revisionId: saved.revision.id,
      locale: 'nl',
    });
    expect(await card()).toMatchObject({ landing: { title: 'Red de rivier nu' } });
  });
});
