// Exercise the edition chosen by publication and by the access projection before estimating time.
import { articleView } from './article-profile.js';
import { ContentDocument } from '../model.js';
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

it('counts only the served locale and ignores an empty body and non-editorial fields', () => {
  const doc = ContentDocument.parse({
    type: 'article',
    locales: ['nl', 'en'],
    defaultLocale: 'nl',
    title: { nl: 'Titel', en: 'Title' },
    presentation: { profile: 'post' },
    blocks: [],
  });
  if (doc.type !== 'article') throw new Error('article fixture');
  expect(articleView(doc, 'en')?.minutes).toBeNull();
  doc.lead = { nl: 'woord '.repeat(201), en: 'word' };
  expect(articleView(doc, 'nl')?.minutes).toBe(2);
  expect(articleView(doc, 'en')?.minutes).toBe(1);
  doc.presentation = {
    profile: 'longread',
    overrides: { longread: { readingTime: 'hide', initial: 'plain' } },
  };
  expect(articleView(doc, 'en')).toEqual({
    header: 'cover',
    portraits: true,
    minutes: null,
    initial: false,
  });
});

it('puts the first served recording on top of a media article and falls back to Post without one', () => {
  const video = (id: string) => ({
    id,
    type: 'video' as const,
    version: 1 as const,
    props: { videoId: '44444444-4444-4444-8444-444444444444' },
  });
  const doc = ContentDocument.parse({
    type: 'article',
    locales: ['nl'],
    defaultLocale: 'nl',
    title: { nl: 'Aflevering' },
    lead: { nl: 'Een gesprek' },
    presentation: { profile: 'media' },
    blocks: [
      { id: 'intro', type: 'heading', version: 1, props: { text: { nl: 'Vooraf' } } },
      video('first'),
      video('second'),
    ],
  });
  if (doc.type !== 'article') throw new Error('article fixture');
  expect(articleView(doc, 'nl')).toEqual({
    header: 'standard',
    portraits: false,
    minutes: 1,
    initial: false,
    video: { blockId: 'first', duration: true },
  });
  doc.presentation = { profile: 'media', overrides: { media: { readingTime: 'hide' } } };
  expect(articleView(doc, 'nl')?.video).toEqual({ blockId: 'first', duration: false });
  doc.blocks = doc.blocks.filter((block) => block.type !== 'video');
  doc.presentation = { profile: 'media', overrides: { media: { header: 'cover' } } };
  const media = articleView(doc, 'nl');
  doc.presentation = { profile: 'post', overrides: { post: { header: 'cover' } } };
  expect(media).toEqual(articleView(doc, 'nl'));
  expect(media?.video).toBeUndefined();
});
