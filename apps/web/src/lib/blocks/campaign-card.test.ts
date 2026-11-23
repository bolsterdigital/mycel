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
  const resolve = (
    blocks: Block[],
    options: { diagnose?: boolean; tenant?: string; itemId?: string } = {}
  ) =>
    resolveDocument(
      sourceFor(options.tenant),
      { locale: 'nl', title: 'Thuis', blocks },
      {
        base: '',
        fallbackLocale: 'nl',
        ...(options.diagnose ? { diagnose: true } : {}),
        ...(options.itemId ? { itemId: options.itemId } : {}),
      }
    );
  /** The landing page as the public site (or, with `diagnose`, the preview) renders it. */
  const landing = async (blocks?: Block[], diagnose = false) => {
    const { revision } = await invoker.run(useCases.getItem, admin, {
      itemId: campaign.landingItemId,
    });
    return resolve(blocks ?? projectDocument(revision.document, 'nl').blocks, {
      itemId: campaign.landingItemId,
      diagnose,
    });
  };
  /** Gives the landing page these blocks in a new draft (publish it to show them). */
  const write = async (blocks: Block[]) => {
    const { revision } = await invoker.run(useCases.getItem, admin, {
      itemId: campaign.landingItemId,
    });
    await invoker.run(useCases.updateItem, admin, {
      itemId: campaign.landingItemId,
      baseRevisionId: revision.id,
      document: { ...revision.document, blocks },
    });
  };
  return { invoker, admin, campaign, publishLanding, open, close, card, resolve, landing, write };
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
      body: null,
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

  it('gives a landing page its campaign: the form only while open, the stand otherwise (ADR 038)', async () => {
    const { publishLanding, open, close, landing, card, resolve, campaign } = await setup();
    await publishLanding();
    // Rule 6: the landing page places no form block; the campaign brings its form.
    const before = await landing();
    expect(before.blocks).toEqual([]);
    expect(before.campaign).toMatchObject({
      kind: 'petition',
      phase: 'upcoming',
      opens: null,
      form: null,
      counter: { participants: 0, target: 500 },
    });
    expect(before.campaign).not.toHaveProperty('diagnosis');
    expect(hasForm(before)).toBe(false);
    // An ordinary page is no campaign's landing page.
    expect(await resolve([])).not.toHaveProperty('campaign');

    await open();
    const during = await landing();
    expect(during.campaign).toMatchObject({ phase: 'open', form: { formId: campaign.formId } });
    expect(hasForm(during)).toBe(true);
    // A form block placing the campaign's own form renders nothing beside the action column, and
    // a full card of the same campaign on its landing page does not show the form a second time.
    const placed = await landing([
      {
        id: 'f',
        type: 'form',
        version: 1,
        props: { formId: campaign.formId!, variant: 'default', width: 'content' },
      },
      card('k'),
    ]);
    expect(placed.blocks[0]).toEqual({
      id: 'f',
      type: 'form',
      variant: 'default',
      width: 'content',
      form: null,
    });
    expect(placed.blocks[1]).toMatchObject({ campaign: { phase: 'open' }, form: null });

    await close();
    const after = await landing();
    expect(after.campaign).toMatchObject({
      phase: 'closed',
      form: null,
      counter: { participants: 0, target: 500 },
    });
    expect(hasForm(after)).toBe(false);
  });

  it('keeps the form in the preview of a landing page outside open participation, with the reason', async () => {
    const { campaign, publishLanding, open, close, landing } = await setup();
    // A draft landing page in a draft campaign: the preview shows the form and why the site will not.
    expect((await landing(undefined, true)).campaign).toMatchObject({
      phase: 'upcoming',
      form: { formId: campaign.formId },
      diagnosis: 'upcoming',
    });
    await publishLanding();
    expect((await landing()).campaign).toMatchObject({ form: null });
    await open();
    const opened = (await landing(undefined, true)).campaign;
    expect(opened).toMatchObject({ form: { formId: campaign.formId } });
    expect(opened).not.toHaveProperty('diagnosis');
    await close();
    expect((await landing(undefined, true)).campaign).toMatchObject({
      form: { formId: campaign.formId },
      diagnosis: 'closed',
    });
  });

  it('keeps a bound form block elsewhere in the preview before participation opens, with the reason', async () => {
    const { campaign, publishLanding, open, close, resolve } = await setup();
    // The campaign's form placed as a block on another page: gated by the campaign (ADR 033 rule 2).
    const own = async (diagnose: boolean) => {
      const model = await resolve(
        [
          {
            id: 'f',
            type: 'form',
            version: 1,
            props: { formId: campaign.formId!, variant: 'default', width: 'content' },
          },
        ],
        { diagnose }
      );
      return model.blocks.find((b) => b.type === 'form');
    };
    // A draft landing page: the public model holds nothing, the preview the form and the reason.
    expect(await own(false)).toMatchObject({ form: null, campaign: null });
    expect(await own(false)).not.toHaveProperty('diagnosis');
    expect(await own(true)).toMatchObject({
      form: { formId: campaign.formId },
      diagnosis: 'draft',
    });
    await publishLanding();
    expect(await own(true)).toMatchObject({
      form: { formId: campaign.formId },
      diagnosis: 'upcoming',
    });
    await open();
    expect(await own(true)).toMatchObject({ form: { formId: campaign.formId } });
    expect(await own(true)).not.toHaveProperty('diagnosis');
    await close();
    expect(await own(true)).toMatchObject({
      form: { formId: campaign.formId },
      diagnosis: 'closed',
    });
    expect(await own(false)).toMatchObject({ form: null, campaign: { phase: 'closed' } });
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

describe('the campaign text in a full card (ADR 038 rule 4)', () => {
  const para = (text: string) => ({
    type: 'doc' as const,
    content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
  });
  const heading: Block = {
    id: 'kop',
    type: 'heading',
    version: 1,
    props: { text: { nl: 'Wij constateren' } },
  };
  const prose = (text: string): Block => ({
    id: 'tekst',
    type: 'rich-text',
    version: 1,
    props: { content: { nl: para(text) } },
  });
  const cta: Block = {
    id: 'meer',
    type: 'cta',
    version: 2,
    props: {
      variant: 'band',
      title: { nl: 'Meer' },
      actions: [{ label: { nl: 'Lees' }, target: { kind: 'url', url: '/meer' } }],
      width: 'content',
      align: 'start',
    },
  };

  it('shows the text blocks of the published revision, ids from the card, folded with a heading', async () => {
    const { card, resolve, publishLanding, open, write } = await setup();
    await write([heading, prose('Het park verdwijnt.'), cta]);
    await publishLanding();
    await open();
    const model = await resolve([card('a'), card('b'), card('c', 'compact')]);
    const [a, b, c] = model.blocks;
    expect(a).toMatchObject({
      body: {
        blocks: [
          { id: 'a-kop', type: 'heading', text: 'Wij constateren' },
          { id: 'a-tekst', type: 'rich-text' },
        ],
        more: true,
        open: false,
      },
    });
    // A second card of the same campaign: the same text under its own ids.
    expect(b).toMatchObject({ body: { blocks: [{ id: 'b-kop' }, { id: 'b-tekst' }] } });
    expect(c).toMatchObject({ body: null });
    // Markdown keeps a card a link with title and summary: no text, no count.
    expect(
      renderMarkdown(model, {
        canonicalUrl: 'https://probe.example/thuis',
        siteRoot: 'https://probe.example',
      })
    ).not.toContain('constateren');
  });

  it('shows a short text without a subheading open, and none at all without text', async () => {
    const { card, resolve, publishLanding, open, write } = await setup();
    await publishLanding();
    await open();
    expect((await resolve([card('k')])).blocks[0]).toMatchObject({ body: null });
    await write([prose('Het park verdwijnt.')]);
    await publishLanding();
    expect((await resolve([card('k')])).blocks[0]).toMatchObject({
      body: { more: false, open: true },
    });
  });
});
