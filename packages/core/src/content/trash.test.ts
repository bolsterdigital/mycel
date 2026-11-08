// The rules of the trash (ADR 030) over the memory adapter; `packages/db/src/content.test.ts` holds
// the Postgres adapter to the same reads, the partial slug key and the tenant boundary.

import { describe, expect, it } from 'vitest';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, type Principal } from '../principal.js';
import { FakeClock, MemoryUnitOfWork, TENANT, principal } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';

const doc = (title: string, blocks: unknown[] = []) => ({
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl'],
  title: { nl: title },
  blocks,
});

const linkTo = (itemId: string) => ({
  id: 'link',
  type: 'rich-text',
  version: 1,
  props: {
    content: {
      nl: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'zie', marks: [{ type: 'link', attrs: { itemId } }] }],
          },
        ],
      },
    },
  },
});

function setup() {
  const clock = new FakeClock();
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork({ clock }));
  const admin = principal({
    capabilities: ['content:read', 'content:write', 'content:publish'],
  });
  const create = (slug: string, title = slug, blocks: unknown[] = []) =>
    invoker.run(useCases.createItem, admin, { slug, document: doc(title, blocks) as never });
  const publish = async (itemId: string, revisionId: string, p: Principal = admin) =>
    invoker.run(useCases.publishItem, p, { itemId, revisionId, locale: 'nl' });
  return { clock, invoker, admin, create, publish };
}

describe('the content trash', () => {
  it('takes a live item offline and leaves it out of every other operation', async () => {
    const { invoker, admin, create, publish } = setup();
    const { item, revision } = await create('over-ons', 'Over ons');
    await publish(item.id, revision.id);
    const visitor = anonymousPrincipal(TENANT, ['content:read']);
    await invoker.run(useCases.getPublished, visitor, { type: 'page', slug: 'over-ons' });

    await invoker.run(useCases.deleteItem, admin, { itemId: item.id });

    await expect(
      invoker.run(useCases.getPublished, visitor, { type: 'page', slug: 'over-ons' })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(invoker.run(useCases.getItem, admin, { itemId: item.id })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      invoker.run(useCases.unpublishItem, admin, { itemId: item.id, locale: 'nl' })
    ).rejects.toMatchObject({ code: 'not_found' });
    const { items, total } = await invoker.run(useCases.listItems, admin, { type: 'page' });
    expect(items).toEqual([]);
    expect(total).toBe(0);
    const trash = await invoker.run(useCases.listContentTrash, admin, {});
    expect(trash.total).toBe(1);
    expect(trash.items[0]).toMatchObject({ id: item.id, slug: 'over-ons' });
  });

  it('ends planning and offers, and a restore publishes nothing', async () => {
    const { clock, invoker, admin, create, publish } = setup();
    const { item, revision } = await create('plan');
    await publish(item.id, revision.id);
    await invoker.run(useCases.scheduleItem, admin, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
      at: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });

    await invoker.run(useCases.deleteItem, admin, { itemId: item.id });
    const { item: back, slugChanged } = await invoker.run(useCases.restoreItem, admin, {
      itemId: item.id,
    });

    expect(slugChanged).toBe(false);
    expect(back.publication[0]).toMatchObject({
      status: 'unpublished',
      publishedRevisionId: null,
      scheduleId: null,
      review: null,
    });
    await expect(
      invoker.run(useCases.getPublished, anonymousPrincipal(TENANT, ['content:read']), {
        type: 'page',
        slug: 'plan',
      })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses while another item links to it, naming that item, and allows a self-link', async () => {
    const { invoker, admin, create } = setup();
    const { item: target } = await create('doel', 'Doel');
    const { item: source } = await create('bron', 'Bron', [linkTo(target.id)]);

    await expect(
      invoker.run(useCases.deleteItem, admin, { itemId: target.id })
    ).rejects.toMatchObject({
      code: 'conflict',
      issues: [
        {
          message: 'content.delete.referenced',
          params: { count: '1', titles: 'Bron' },
        },
      ],
    });
    // Nothing happened: the item is still there.
    await invoker.run(useCases.getItem, admin, { itemId: target.id });

    await invoker.run(useCases.deleteItem, admin, { itemId: source.id });
    await invoker.run(useCases.deleteItem, admin, { itemId: target.id });
    expect((await invoker.run(useCases.listContentTrash, admin, {})).total).toBe(2);
  });

  it('frees the slug, and a restore onto a taken slug takes a free one and says so', async () => {
    const { invoker, admin, create } = setup();
    const { item } = await create('nieuws');
    await invoker.run(useCases.deleteItem, admin, { itemId: item.id });
    const { item: replacement } = await create('nieuws');
    expect(replacement.slug).toBe('nieuws');

    const restored = await invoker.run(useCases.restoreItem, admin, { itemId: item.id });

    expect(restored.slugChanged).toBe(true);
    expect(restored.item.slug).toBe('nieuws-2');
  });

  it('asks content:publish, and an id outside the trash cannot be restored', async () => {
    const { invoker, admin, create } = setup();
    const { item } = await create('rechten');
    const author = principal({ capabilities: ['content:read', 'content:write'] });
    for (const useCase of [useCases.deleteItem, useCases.restoreItem])
      await expect(
        invoker.run(useCase as typeof useCases.deleteItem, author, { itemId: item.id })
      ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(invoker.run(useCases.listContentTrash, author, {})).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      invoker.run(useCases.restoreItem, admin, { itemId: item.id })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
