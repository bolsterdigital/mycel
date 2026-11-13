// Fixtures for the campaign card test in signup.spec.ts (ADR 033 rule 4), written through
// the use cases: one petition with its landing page published in Dutch, a never published one and
// an archived one, and three hosts (a page with two cards to the first petition and one each to
// the other two, published in nl and en; an article with one card; a page scheduled an hour ahead
// with one card). Plus the two moves the test makes on the campaign, and the scheduled publish
// as the worker's `content.publish` job runs it, under a clock past the planned time.
import {
  BLOCK_DEFINITIONS as DEFS,
  publishScheduled,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { tenantId, withInvoker } from '../invoker';

const card = (campaignId: string, variant = 'compact', width = 'content') => ({
  type: 'campaign-card' as const,
  version: DEFS['campaign-card'].version,
  props: { campaignId, variant, width },
});
const text = (words: string) => ({
  type: 'rich-text' as const,
  version: DEFS['rich-text'].version,
  props: {
    content: Object.fromEntries(
      ['nl', 'en'].map((l) => [
        l,
        { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: words }] }] },
      ])
    ),
  },
});

export async function campaignCardFixture(stamp: string) {
  const editor = systemPrincipal(await tenantId(), 'e2e-campaign-card');
  const ids = await withInvoker(async (invoker) => {
    const publish = async (itemId: string, revisionId: string, locales = ['nl']) => {
      for (const locale of locales)
        await invoker.run(useCases.publishItem, editor, { itemId, revisionId, locale });
    };
    const start = async (slug: string, live: boolean) => {
      const c = await invoker.run(useCases.composeCampaign, editor, {
        kind: 'petition',
        title: { nl: `Kaart ${slug}`, en: `Card ${slug}` },
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        slug,
        goal: { target: 500, milestones: [] },
      });
      const { item } = await invoker.run(useCases.getItem, editor, { itemId: c.landingItemId });
      if (live) await publish(item.id, item.latestRevisionId);
      return c;
    };
    const c = await start(`kaart-${stamp}`, true);
    const draft = await start(`kaart-concept-${stamp}`, false);
    const old = await start(`kaart-oud-${stamp}`, true);
    await invoker.run(useCases.archiveCampaign, editor, {
      campaignId: old.id,
      baseUpdatedAt: old.updatedAt,
    });
    const host = async (type: 'page' | 'article', slug: string, blocks: unknown[]) =>
      invoker.run(useCases.createItem, editor, {
        slug,
        document: {
          type,
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: `Gast ${slug}`, en: `Host ${slug}` },
          blocks: blocks as never,
        },
      });
    const both = await host('page', `gast-${stamp}`, [
      text('Teken hieronder.'),
      card(c.id, 'full', 'wide'),
      text('Of lees eerst verder.'),
      card(c.id),
      card(draft.id),
      card(old.id),
    ]);
    await publish(both.item.id, both.revision.id, ['nl', 'en']);
    const article = await host('article', `gast-artikel-${stamp}`, [card(c.id)]);
    await publish(article.item.id, article.revision.id);
    const planned = await host('page', `gast-gepland-${stamp}`, [card(c.id)]);
    await invoker.run(useCases.scheduleItem, editor, {
      itemId: planned.item.id,
      revisionId: planned.revision.id,
      locale: 'nl',
      at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    return { c, planned: planned.item.id, plannedRevision: planned.revision.id };
  });

  const campaignAction = (action: 'openCampaign' | 'closeCampaign') =>
    withInvoker(async (invoker) => {
      const campaignId = ids.c.id;
      const { updatedAt } = await invoker.run(useCases.getCampaign, editor, { campaignId });
      await invoker.run(useCases[action], editor, { campaignId, baseUpdatedAt: updatedAt });
    });

  /** A newer landing title goes live, then the scheduled host publishes its pinned revision. */
  const publishOnSchedule = (title: string) =>
    withInvoker(
      async (invoker, uow) => {
        const itemId = ids.c.landingItemId;
        const { revision } = await invoker.run(useCases.getItem, editor, { itemId });
        const saved = await invoker.run(useCases.updateItem, editor, {
          itemId,
          baseRevisionId: revision.id,
          document: { ...revision.document, title: { nl: title, en: title } },
        });
        await invoker.run(useCases.publishItem, editor, {
          itemId,
          revisionId: saved.revision.id,
          locale: 'nl',
        });
        const { item } = await invoker.run(useCases.getItem, editor, { itemId: ids.planned });
        const scheduleId = item.publication.find((p) => p.locale === 'nl')!.scheduleId!;
        const job = { itemId: ids.planned, revisionId: ids.plannedRevision, locale: 'nl' };
        await uow.run(editor, (ctx) => publishScheduled(ctx, { ...job, scheduleId }));
      },
      { clock: { now: () => new Date(Date.now() + 2 * 3_600_000) } }
    );

  return { ids, campaignAction, publishOnSchedule };
}
