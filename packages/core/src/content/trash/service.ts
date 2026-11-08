// Deleting a page or article (ADR 030): a trash, not an erasure. Delete takes the item
// offline and hides it from every other operation; restore brings it back unpublished, with its
// address if that is still free. The rules are here so the admin, the API and MCP share them.
//
// Rejected: leaving an item live or planned while it is in the trash (a restore would publish
// without anyone choosing that), and hiding the item per use case instead of in the repository
// (one forgotten read would serve deleted content).

import { z } from 'zod';
import { UseCaseError, notFound } from '../../errors.js';
import { localized } from '../../i18n/locale.js';
import type { TransactionContext } from '../../ports.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { MAX_PAGE_SIZE } from '../../util/page-size.js';
import { firstFreeSlug, slugTaken } from '../address/slugs.js';
import { unpublish, withdrawReview } from '../lifecycle.js';
import { ContentItem, ContentType, Slug } from '../model.js';
import type { ItemRecord } from '../ports.js';
import { lockItem, toContentItem } from '../service.js';

const ItemId = z.string().guid();
const IsoDate = z.string().datetime({ offset: true });
const MAX_TRASH_OFFSET = 100_000;
/** How many referring items a refusal looks at: enough to name them, not to count a whole site. */
const REFERRERS_LOOKED_AT = 50;
const REFERRERS_NAMED = 3;

/** The other items whose latest or published revision links to this one. */
async function referrers(ctx: TransactionContext, id: string): Promise<ItemRecord[]> {
  const found = new Map<string, ItemRecord>();
  for (const live of [false, true]) {
    const page = await ctx.content.find(
      { ref: { type: 'item', id }, live },
      null,
      REFERRERS_LOOKED_AT
    );
    for (const { item } of page.rows) if (item.id !== id) found.set(item.id, item);
  }
  return [...found.values()];
}

const titleOf = (item: ItemRecord) => item.title[item.defaultLocale] ?? item.slug;

export const deleteItem = defineUseCase({
  name: 'content.item.delete',
  kind: 'command',
  description:
    'Move an item to the trash: every locale goes offline, its planning and offers end, and it is gone from every other operation until restored. Fails with conflict while another item links to it, naming them.',
  requires: 'content:publish',
  input: z.object({ itemId: ItemId }).strict(),
  output: z.object({ id: ItemId, deletedAt: IsoDate }),
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId }) {
    const item = await lockItem(ctx, itemId);
    const linking = await referrers(ctx, itemId);
    if (linking.length)
      throw new UseCaseError('conflict', 'other items link to this item', [
        {
          path: 'itemId',
          message: 'content.delete.referenced',
          params: {
            count: String(linking.length),
            titles: linking.slice(0, REFERRERS_NAMED).map(titleOf).join(', '),
          },
        },
      ]);
    const now = ctx.clock.now();
    await ctx.content.save({
      ...item,
      updatedAt: now,
      publication: item.publication.map((s) => withdrawReview(unpublish(s))),
    });
    await ctx.content.trash(itemId, now);
    return { id: itemId, deletedAt: now.toISOString() };
  },
});

export const restoreItem = defineUseCase({
  name: 'content.item.restore',
  kind: 'command',
  description:
    'Bring an item back from the trash, unpublished. It keeps its slug if that is free; otherwise it gets a free variant and slugChanged is true.',
  requires: 'content:publish',
  input: z.object({ itemId: ItemId }).strict(),
  output: z.object({ item: ContentItem, slugChanged: z.boolean() }),
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId }) {
    const item = await ctx.content.lockTrashed(itemId);
    if (!item) throw notFound('item in the trash');
    const slug = await firstFreeSlug(ctx, item.type, item.slug);
    const now = ctx.clock.now();
    if (!(await ctx.content.restore(itemId, slug, now))) throw slugTaken(item.type, slug);
    return {
      item: toContentItem({ ...item, slug, updatedAt: now }),
      slugChanged: slug !== item.slug,
    };
  },
});

export const listContentTrash = defineUseCase({
  name: 'content.trash.list',
  kind: 'query',
  description: 'List the pages and articles in the trash, most recently deleted first.',
  requires: 'content:publish',
  input: z
    .object({
      offset: z.number().int().min(0).max(MAX_TRASH_OFFSET).optional(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
    })
    .strict(),
  output: z.object({
    items: z.array(
      z.object({
        id: ItemId,
        type: ContentType,
        slug: Slug,
        title: localized(z.string()),
        defaultLocale: z.string(),
        deletedAt: IsoDate,
      })
    ),
    total: z.number().int().nonnegative(),
  }),
  examples: [{ input: {} }],
  async handler(ctx, { offset = 0, limit = 50 }) {
    const { rows, total } = await ctx.content.trashed(offset, limit);
    return {
      items: rows.map(({ item, deletedAt }) => ({
        id: item.id,
        type: item.type,
        slug: item.slug,
        title: item.title,
        defaultLocale: item.defaultLocale,
        deletedAt: deletedAt.toISOString(),
      })),
      total,
    };
  },
});
