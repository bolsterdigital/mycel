// A campaign card and a campaign's form through the real resolver source over the in-memory unit
// of work (ADR 033 rules 2, 4 and 6): what the public model holds per phase, that an unavailable
// campaign leaves nothing (and its reason only for the preview), that two cards or a card beside
// the form render the form once, that another site's campaign never resolves, and what Markdown
// and the form-page check (`hasForm`, no ETag) make of it. The phase and reasons themselves are
// `packages/core/src/campaigns/card.test.ts`.
import { describe, expect, it } from 'vitest';
import {
  anonymousPrincipal,
  buildRegistry,
  Invoker,
  projectDocument,
  systemPrincipal,
  useCases,
  type Block,
} from '@mycel/core';
import { MemoryUnitOfWork } from '@mycel/core/testing';
import { hasForm } from '../server/public/has-form.js';
import { renderMarkdown } from './markdown.js';
import { resolveDocument, runtimeSource } from './resolve.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const TENANT_B = '01900000-0000-7000-8000-00000000bbbb';

async function setup() {
  const uow = new MemoryUnitOfWork();
  const invoker = new Invoker(buildRegistry(), uow);
  const admin = systemPrincipal(TENANT, 'test');
  const campaign = await invoker.run(useCases.composeCampaign, admin, {
    kind: 'petition',
    title: { nl: 'Red het park', en: 'Save the park' },
    defaultLocale: 'nl',
    locales: ['nl', 'en'],
    slug: 'red-het-park',
    goal: { target: 500, milestones: [] },
  });
  const current = async () =>
    (await invoker.run(useCases.getCampaign, admin, { campaignId: campaign.id })).updatedAt;
  const publishLanding = async (locale = 'nl') => {
    const { item } = await invoker.run(useCases.getItem, admin, {
      itemId: campaign.landingItemId,
    });
    await invoker.run(useCases.publishItem, admin, {
      itemId: item.id,
      revisionId: item.latestRevisionId,
      locale,
    });
  };
  const open = async () =>
    invoker.run(useCases.openCampaign, admin, {
      campaignId: campaign.id,
      baseUpdatedAt: await current(),
    });
  const close = async () =>
    invoker.run(useCases.closeCampaign, admin, {
      campaignId: campaign.id,
      baseUpdatedAt: await current(),
    });
  const sourceFor = (tenant = TENANT) =>
    runtimeSource({
      invoker,
      uow,
      reader: anonymousPrincipal(tenant, ['content:read', 'forms:read', 'media:read']),
      defaultLocale: 'nl',
    });
  const card = (id: string, variant: 'compact' | 'full' = 'full'): Block => ({
    id,
    type: 'campaign-card',
    version: 1,
    props: { campaignId: campaign.id, variant, width: 'content' },
  });
  const resolve = (blocks: Block[], options: { diagnose?: boolean; tenant?: string } = {}) =>
    resolveDocument(
      sourceFor(options.tenant),
      { locale: 'nl', title: 'Thuis', blocks },
      { base: '', fallbackLocale: 'nl', ...(options.diagnose ? { diagnose: true } : {}) }
    );
  /** The landing page as the public site renders it: its own form block. */
  const landing = async () => {
    const { revision } = await invoker.run(useCases.getItem, admin, {
      itemId: campaign.landingItemId,
    });
    return resolve(projectDocument(revision.document, 'nl').blocks);
  };
  return { invoker, admin, campaign, publishLanding, open, close, card, resolve, landing };
}

describe('a campaign card in the render model (ADR 033 rule 4)', () => {
  it('shows nothing for a draft landing page, and says why only to the preview', async () => {
    const { card, resolve } = await setup();
    const [shown] = (await resolve([card('k')])).blocks;
    expect(shown).toEqual({
      id: 'k',
      type: 'campaign-card',
      variant: 'full',
      width: 'content',
      campaign: null,
      form: null,
    });
    const [diagnosed] = (await resolve([card('k')], { diagnose: true })).blocks;
    expect(diagnosed).toMatchObject({ campaign: null, diagnosis: 'draft' });
  });

  it("never resolves another site's campaign", async () => {
    const { card, resolve, publishLanding, open } = await setup();
    await publishLanding();
    await open();
    const [shown] = (await resolve([card('k')], { tenant: TENANT_B, diagnose: true })).blocks;
    expect(shown).toMatchObject({ campaign: null, form: null, diagnosis: 'unknown' });
  });

  it('gives the form only to a full card while open, once per page, never a closed one', async () => {
    const { card, resolve, publishLanding, open, close, campaign } = await setup();
    await publishLanding();
    const upcoming = (await resolve([card('k')])).blocks[0];
    expect(upcoming).toMatchObject({
      campaign: {
        campaignId: campaign.id,
        kind: 'petition',
        phase: 'upcoming',
        href: '/red-het-park',
        title: 'Red het park',
        counter: { participants: 0, target: 500 },
      },
      form: null,
    });

    await open();
    const model = await resolve([card('a'), card('b'), card('c', 'compact')]);
    const forms = model.blocks.map((b) => (b.type === 'campaign-card' ? b.form?.formId : 'x'));
    // Element ids derive from the form id: the second full card renders as compact.
    expect(forms).toEqual([campaign.formId, undefined, undefined]);
    expect(model.blocks.every((b) => b.type === 'campaign-card' && b.campaign)).toBe(true);
    expect(hasForm(model)).toBe(true);

    await close();
    const closed = await resolve([card('a')]);
    expect(closed.blocks[0]).toMatchObject({ campaign: { phase: 'closed' }, form: null });
    expect(hasForm(closed)).toBe(false);
  });

  it('renders the landing page form only while open, and its result otherwise (rule 2)', async () => {
    const { publishLanding, open, close, landing, card, resolve, campaign } = await setup();
    await publishLanding();
    const before = (await landing()).blocks.find((b) => b.type === 'form');
    expect(before).toMatchObject({ form: null, campaign: { phase: 'upcoming' } });

    await open();
    const during = await landing();
    const form = during.blocks.find((b) => b.type === 'form');
    expect(form).toMatchObject({ form: { formId: campaign.formId } });
    expect(form).not.toHaveProperty('campaign');
    expect(hasForm(during)).toBe(true);
    // A card beside the campaign's own form block shows the campaign, not a second form.
    const both = await resolve([
      {
        id: 'f',
        type: 'form',
        version: 1,
        props: { formId: campaign.formId!, variant: 'default', width: 'content' },
      },
      card('k'),
    ]);
    expect(both.blocks[1]).toMatchObject({ campaign: { phase: 'open' }, form: null });

    await close();
    const after = await landing();
    expect(after.blocks.find((b) => b.type === 'form')).toMatchObject({
      form: null,
      campaign: { phase: 'closed', counter: { participants: 0, target: 500 } },
    });
    expect(hasForm(after)).toBe(false);
  });

  it('is a link with title and summary in Markdown: no form, no count', async () => {
    const { card, resolve, publishLanding, open } = await setup();
    await publishLanding();
    await open();
    const markdown = renderMarkdown(await resolve([card('k')]), {
      canonicalUrl: 'https://probe.example/thuis',
      siteRoot: 'https://probe.example',
    });
    expect(markdown).toBe('# Thuis\n\n## [Red het park](<https://probe.example/red-het-park>)\n');
  });
});
