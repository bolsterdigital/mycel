// Access tiers as use cases (ADR 016 rule 2): create, update, get and list, like the other tenant
// entities beside content (entities.ts). Writing a tier asks for `content:publish`, not
// `content:write`: a tier's name is the copy a visitor reads on a restricted published article,
// and a tier decides who reads what is published. Reading is `content:read`, which the editor
// needs to pick a tier. No delete (content/ports.ts), and slug and kind are fixed at create, so no tier
// write can widen access to something already published.

import { z } from 'zod';
import { notFound } from '../../errors.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { MAX_PAGE_SIZE } from '../../util/page-size.js';
import { BaseUpdatedAt, assertFreeSlug, slugTaken, updateEntity } from '../entities.js';
import { Slug } from '../model.js';
import { DEFAULT_PAGE_SIZE } from '../service.js';
import { AccessTier, AccessTierInput, AccessTierKind } from './model.js';
import '../ports.js';

export const createAccessTier = defineUseCase({
  name: 'content.access_tier.create',
  kind: 'command',
  description:
    'Create an access tier that restricted articles can ask for and that supporters can be granted. Slug and kind are fixed afterwards; a paid tier opens through a grant until memberships exist.',
  requires: 'content:publish',
  consumes: null,
  input: AccessTierInput.extend({ slug: Slug, kind: AccessTierKind.default('free') }),
  output: AccessTier,
  examples: [{ input: { slug: 'leden', name: { nl: 'Leden', en: 'Members' } } }],
  async handler(ctx, { slug, ...fields }) {
    await assertFreeSlug(ctx.accessTiers, slug, 'an access tier');
    const now = ctx.clock.now().toISOString();
    const tier: AccessTier = {
      ...fields,
      id: ctx.ids.next(),
      slug,
      createdAt: now,
      updatedAt: now,
    };
    if (!(await ctx.accessTiers.insert(tier))) throw slugTaken('an access tier', slug);
    return tier;
  },
});

export const updateAccessTier = defineUseCase({
  name: 'content.access_tier.update',
  kind: 'command',
  description:
    'Replace the name, description and order of an access tier; slug and kind stay as they are. baseUpdatedAt is the updatedAt you read: when the tier changed since, the update fails with conflict naming when.',
  requires: 'content:publish',
  input: AccessTierInput.extend({ tierId: z.string().guid(), baseUpdatedAt: BaseUpdatedAt }),
  output: AccessTier,
  examples: [
    {
      input: {
        tierId: exampleId(1),
        baseUpdatedAt: '2026-11-01T09:00:00.000Z',
        name: { nl: 'Leden' },
      },
    },
  ],
  handler: (ctx, { tierId, baseUpdatedAt, ...fields }) =>
    updateEntity(
      ctx,
      ctx.accessTiers,
      'access tier',
      tierId,
      baseUpdatedAt,
      (current, updatedAt) => ({
        ...fields,
        id: current.id,
        slug: current.slug,
        kind: current.kind,
        createdAt: current.createdAt,
        updatedAt,
      })
    ),
});

export const getAccessTier = defineUseCase({
  name: 'content.access_tier.get',
  kind: 'query',
  description: 'Get an access tier.',
  requires: 'content:read',
  input: z.object({ tierId: z.string().guid() }),
  output: AccessTier,
  examples: [{ input: { tierId: exampleId(1) } }],
  async handler(ctx, { tierId }) {
    return (await ctx.accessTiers.get(tierId)) ?? Promise.reject(notFound('access tier'));
  },
});

export const listAccessTiers = defineUseCase({
  name: 'content.access_tier.list',
  kind: 'query',
  description: 'List access tiers newest first, a page at a time; each carries its display order.',
  requires: 'content:read',
  input: z.object({
    after: z.string().guid().optional(),
    limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  }),
  output: z.object({ tiers: z.array(AccessTier), next: z.string().guid().nullable() }),
  examples: [{ input: {} }],
  async handler(ctx, { after, limit }) {
    const page = await ctx.accessTiers.list(after ?? null, limit ?? DEFAULT_PAGE_SIZE);
    return { tiers: page.rows, next: page.next };
  },
});
