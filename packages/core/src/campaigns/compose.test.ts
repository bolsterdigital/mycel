// `campaign.landing.create`: form, draft landing page and campaign in one transaction, with the
// checks of the three use cases it runs; plus the two reads the admin builds on, the list with its
// landing summary and the campaign of a page.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import type { Capability } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, expectCode, principal } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';

function setup() {
  const clock = new FakeClock();
  const uow = new MemoryUnitOfWork({ clock });
  const invoker = new Invoker(buildRegistry(), uow);
  const as = (capabilities: Capability[]) => principal({ capabilities });
  const admin = as(['content:read', 'content:write', 'content:publish', 'forms:write']);
  const compose = (input: Record<string, unknown> = {}, p = admin) =>
    invoker.run(useCases.composeCampaign, p, {
      kind: 'petition',
      title: { nl: 'Red het park', en: 'Save the park' },
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      ...input,
    } as never);
  const counts = async () => {
    const items = await invoker.run(useCases.listItems, admin, { type: 'page' });
    const { forms } = await invoker.run(useCases.listForms, admin, {});
    const { campaigns } = await invoker.run(useCases.listCampaigns, admin, {});
    return { pages: items.total, forms: forms.length, campaigns: campaigns.length };
  };
  return { invoker, admin, as, compose, counts };
}

describe('campaign.landing.create', () => {
  it('makes a form of the kind, a draft page that places it and a draft campaign', async () => {
    const { invoker, admin, compose } = setup();
    const campaign = await compose({ goal: { target: 500, milestones: [] } });
    expect(campaign).toMatchObject({
      kind: 'petition',
      participation: { state: 'draft' },
      goal: { target: 500 },
      participants: 0,
    });
    const { item, revision } = await invoker.run(useCases.getItem, admin, {
      itemId: campaign.landingItemId,
    });
    expect(item).toMatchObject({ type: 'page', slug: 'red-het-park' });
    expect(item.publication.every((p) => p.status === 'draft')).toBe(true);
    expect(revision.document.title).toEqual({ nl: 'Red het park', en: 'Save the park' });
    expect(revision.document.blocks).toMatchObject([
      { type: 'form', props: { formId: campaign.formId } },
    ]);
    const { form } = await invoker.run(useCases.getFormForAuthoring, admin, {
      id: campaign.formId!,
    });
    expect(form.kind).toBe('petition');
  });

  it('makes a signup with a signup form', async () => {
    const { invoker, admin, compose } = setup();
    const campaign = await compose({ kind: 'signup', title: { nl: 'Doe mee' }, locales: ['nl'] });
    const { form } = await invoker.run(useCases.getFormForAuthoring, admin, {
      id: campaign.formId!,
    });
    expect(form.kind).toBe('signup');
  });

  // The memory adapter has no rollback; that a refusal leaves no orphan form behind is proven
  // over Postgres in packages/db/src/campaigns/repository.test.ts.
  it('refuses a taken or reserved slug as content.item.create does', async () => {
    const { compose } = setup();
    await compose({ slug: 'teken' });
    await expectCode(compose({ slug: 'teken' }), 'conflict');
    await expectCode(compose({ slug: 'admin' }), 'invalid_input');
  });

  it('needs form rights and, for a petition or signup form, publishing permission', async () => {
    const { compose, counts, as } = setup();
    // Both refuse before anything is written, so even the memory adapter keeps nothing.
    await expectCode(
      compose({}, as(['content:read', 'content:write', 'content:publish'])),
      'forbidden'
    );
    await expectCode(
      compose({}, as(['content:read', 'content:write', 'forms:write'])),
      'forbidden'
    );
    expect(await counts()).toEqual({ pages: 0, forms: 0, campaigns: 0 });
  });

  it('refuses a fundraiser, which waits for the ledger', async () => {
    const { compose } = setup();
    await expectCode(compose({ kind: 'fundraiser' }), 'invalid_input');
  });
});

describe('the reads the admin builds on', () => {
  it('lists a campaign with its landing title, slug and published locales', async () => {
    const { invoker, admin, compose } = setup();
    const campaign = await compose();
    const { item } = await invoker.run(useCases.getItem, admin, {
      itemId: campaign.landingItemId,
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
    const { campaigns } = await invoker.run(useCases.listCampaigns, admin, {});
    expect(campaigns).toMatchObject([
      {
        id: campaign.id,
        landing: {
          title: { nl: 'Red het park', en: 'Save the park' },
          slug: 'red-het-park',
          published: ['nl'],
        },
      },
    ]);
  });

  it('reads the campaign of a landing page, and null for any other page', async () => {
    const { invoker, admin, compose } = setup();
    const campaign = await compose();
    expect(
      await invoker.run(useCases.getLandingCampaign, admin, { itemId: campaign.landingItemId })
    ).toEqual({ campaign });
    const { item } = await invoker.run(useCases.createItem, admin, {
      slug: 'over-ons',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Over ons' },
        blocks: [],
      } as never,
    });
    expect(await invoker.run(useCases.getLandingCampaign, admin, { itemId: item.id })).toEqual({
      campaign: null,
    });
  });
});
