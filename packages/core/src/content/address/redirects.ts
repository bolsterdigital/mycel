// Old addresses of an item (migration 0062). `content.slug.update` keeps an item's old
// slug once a locale was published; these use cases read the list for the edit screen, remove one
// on an explicit request, and tell the public router where an old address goes now. A removal is
// never a side effect of a render or a save, so the list only shrinks when an editor asks.
//
// The forward is to the item, not to a stored path: the target is what the item is published as
// at the moment of the request, in the locale the old URL asked for. It answers only when that
// locale is published, the same test as `content.published.get`, so an old address reveals no
// more than the new one would; a restricted item has a public address too, where its teaser is.
// Rejected: forwarding to an unpublished item and letting the target answer 404, which would
// leak its new slug through `Location`.

import { z } from 'zod';
import { notFound } from '../../errors.js';
import { Locale } from '../../i18n/locale.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { statusOf } from '../lifecycle.js';
import { ContentType, Slug } from '../model.js';
import { lockItem } from '../service.js';
import '../ports.js';

const ItemId = z.string().guid();

export const resolveRedirect = defineUseCase({
  name: 'content.redirect.resolve',
  kind: 'query',
  description:
    'Where an old address of a page or article goes now: the type and current slug of the item it forwards to, when that item is published in the given locale; otherwise not found.',
  requires: 'content:read',
  input: z.object({ type: ContentType, slug: Slug, locale: Locale }),
  output: z.object({ type: ContentType, slug: Slug }),
  examples: [{ input: { type: 'page', slug: 'about', locale: 'nl' } }],
  async handler(ctx, { type, slug, locale }) {
    const missing = () => notFound(`old ${type} address`, `slug "${slug}"`);
    const itemId = await ctx.content.redirectOf(type, slug);
    const item = itemId ? await ctx.content.get(itemId) : null;
    if (!item || item.profile === 'zone') throw missing();
    const state = item.publication.find((s) => s.locale === locale);
    if (!state || statusOf(state) !== 'published') throw missing();
    const revision = await ctx.content.revision(item.id, state.publishedRevisionId!);
    if (!revision) throw missing();
    return { type: item.type, slug: item.slug };
  },
});

export const listRedirects = defineUseCase({
  name: 'content.redirect.list',
  kind: 'query',
  description: 'The old addresses of an item that forward to it, oldest first.',
  requires: 'content:read',
  input: z.object({ itemId: ItemId }),
  output: z.object({
    redirects: z.array(z.object({ slug: Slug, createdAt: z.string().datetime() })),
  }),
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId }) {
    if (!(await ctx.content.get(itemId))) throw notFound('content item');
    const rows = await ctx.content.redirects(itemId);
    return {
      redirects: rows.map((r) => ({ slug: r.slug, createdAt: r.createdAt.toISOString() })),
    };
  },
});

export const deleteRedirect = defineUseCase({
  name: 'content.redirect.delete',
  kind: 'command',
  description:
    'Remove an old address of an item: it stops forwarding and its slug becomes free for any item of the type.',
  requires: 'content:write',
  input: z.object({ itemId: ItemId, slug: Slug }),
  output: z.object({ itemId: ItemId, slug: Slug }),
  examples: [{ input: { itemId: exampleId(0x1), slug: 'about' } }],
  async handler(ctx, { itemId, slug }) {
    const item = await lockItem(ctx, itemId);
    if ((await ctx.content.redirectOf(item.type, slug)) !== itemId)
      throw notFound('old address', `slug "${slug}"`);
    await ctx.content.dropRedirect(item.type, slug);
    return { itemId, slug };
  },
});
