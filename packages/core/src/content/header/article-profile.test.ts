// Exercise the edition chosen by publication and by the access projection before estimating time.
import { expect, it } from 'vitest';
import { Invoker } from '../../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT } from '../../testing/index.js';
import { buildRegistry, useCases } from '../../use-cases.js';
it('estimates only visible words for a new Post and preserves a scheduled legacy header', async () => {
  const clock = new FakeClock();
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork({ clock }));
  const admin = systemPrincipal(TENANT, 'test');
  const visitor = () => anonymousPrincipal(TENANT, ['content:read']);
  const create = (document: Parameters<typeof useCases.createItem.input.parse>[0], slug: string) =>
    invoker.run(useCases.createItem, admin, useCases.createItem.input.parse({ document, slug }));
  const input = {
    type: 'article' as const,
    defaultLocale: 'nl',
    locales: ['nl'],
    title: { nl: 'Kort' },
    lead: { nl: 'Kort bericht' },
    access: { level: 'members' as const, teaser: 'lead' as const },
    blocks: [
      { type: 'heading' as const, version: 1 as const, props: { text: { nl: 'Verborgen tekst' } } },
    ],
  };
  const body = {
    type: 'rich-text' as const,
    version: 1 as const,
    props: {
      content: {
        nl: {
          type: 'doc' as const,
          content: [
            {
              type: 'paragraph' as const,
              content: [{ type: 'text' as const, text: 'verborgen '.repeat(450) }],
            },
          ],
        },
      },
    },
  };
  const { item, revision } = await create({ ...input, blocks: [body] }, 'kort');
  expect(revision.document.presentation).toEqual({ profile: 'post' });
  await invoker.run(useCases.publishItem, admin, {
    itemId: item.id,
    revisionId: revision.id,
    locale: 'nl',
  });
  const teaser = await invoker.run(useCases.getPublished, visitor(), {
    type: 'article',
    slug: 'kort',
  });
  expect(teaser.articleView).toEqual({
    header: 'standard',
    minutes: 1,
    portraits: false,
    initial: false,
  });
  const old = await create({ ...input, presentation: { header: 'cover' } }, 'oud');
  await invoker.run(useCases.scheduleItem, admin, {
    itemId: old.item.id,
    revisionId: old.revision.id,
    locale: 'nl',
    at: new Date(clock.now().getTime() + 60_000).toISOString(),
  });
  const changed = await invoker.run(useCases.updateItem, admin, {
    itemId: old.item.id,
    baseRevisionId: old.revision.id,
    document: { ...input, presentation: { profile: 'longread' } },
  });
  expect(changed.item.publication.find((p) => p.locale === 'nl')?.scheduledRevisionId).toBe(
    old.revision.id
  );
  const pinned = await invoker.run(useCases.getItem, admin, {
    itemId: old.item.id,
    revisionId: old.revision.id,
  });
  expect(pinned.revision.document.presentation).toEqual({ header: 'cover' });
});
