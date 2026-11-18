// Access tiers as use cases (ADR 016 rule 2): create, update, get and list, like the other tenant
// entities beside content (entities.ts). Writing a tier asks for `content:publish`, not
// `content:write`: a tier's name is the copy a visitor reads on a restricted published article,
// and a tier decides who reads what is published. Reading is `content:read`, which the editor
// needs to pick a tier. No delete (content/ports.ts), and slug and kind are fixed at create, so no tier
// write can widen access to something already published.
//
// A paid tier carries its prices (brief MY-254 PR 4, choice 9). A change of price raises
// `priceVersion`, which a membership records when it starts, so nobody's running membership is
// charged a price they did not agree to (moving members to a new price is a note).

import { z } from 'zod';
import { UseCaseError, notFound } from '../../errors.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { MAX_PAGE_SIZE } from '../../util/page-size.js';
import { BaseUpdatedAt, assertFreeSlug, slugTaken, updateEntity } from '../entities.js';
import { Slug } from '../model.js';
import { DEFAULT_PAGE_SIZE } from '../service.js';
import {
  AccessTier,
  AccessTierInput,
  AccessTierKind,
  tierIntervals,
  type TierPrices,
} from './model.js';
import '../ports.js';

/** Only a paid tier has prices. */
function assertPrices(kind: AccessTierKind, prices: TierPrices): void {
  if (kind === 'free' && tierIntervals(prices).length)
    throw new UseCaseError('invalid_input', 'only a paid tier has prices', [
      { path: 'prices', message: 'content.access_tier.prices-paid-only' },
    ]);
}

const samePrices = (a: TierPrices, b: TierPrices): boolean =>
  a.month === b.month && a.year === b.year;

export const createAccessTier = defineUseCase({
  name: 'content.access_tier.create',
  kind: 'command',
  description:
    'Create an access tier that restricted articles can ask for and that supporters can be granted. Slug and kind are fixed afterwards. A paid tier may carry prices per interval in minor units (`prices.month`, `prices.year`), which a membership form sells, and a `signupPath` where a visitor becomes a member.',
  requires: 'content:publish',
  consumes: null,
  input: AccessTierInput.extend({ slug: Slug, kind: AccessTierKind.default('free') }),
  output: AccessTier,
  examples: [{ input: { slug: 'leden', name: { nl: 'Leden', en: 'Members' } } }],
  async handler(ctx, { slug, ...fields }) {
    assertPrices(fields.kind, fields.prices);
    await assertFreeSlug(ctx.accessTiers, slug, 'an access tier');
    const now = ctx.clock.now().toISOString();
    const tier: AccessTier = {
      ...fields,
      id: ctx.ids.next(),
      slug,
      priceVersion: 1,
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
    'Replace the name, description, order, prices and signup page of an access tier; slug and kind stay as they are. A change of prices raises `priceVersion`; running memberships keep the price they started with. baseUpdatedAt is the updatedAt you read: when the tier changed since, the update fails with conflict naming when.',
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
      (current, updatedAt) => {
        assertPrices(current.kind, fields.prices);
        return {
          ...fields,
          id: current.id,
          slug: current.slug,
          kind: current.kind,
          priceVersion: samePrices(current.prices, fields.prices)
            ? current.priceVersion
            : current.priceVersion + 1,
          createdAt: current.createdAt,
          updatedAt,
        };
      }
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
