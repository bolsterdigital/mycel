// Access tiers and the one access decision (ADR 016 rules 2 and 3, ADR 019 rules 4 and 5). A tier
// is tenant data that an article's `access.tierIds` and a supporter's grant both point at;
// `hasAccess` is the pure policy every representation asks before it serialises a restricted
// block. It takes the clock as an argument and reads nothing, so the answer is computed at each
// read and never stored. Rejected: an `expired` flag written by a sweeper (ADR 019 rejected
// alternatives: the sweeper's clock would become the truth) and a check per front, which is how
// HTML and JSON come to disagree.

import { z } from 'zod';
import { localized } from '../../i18n/locale.js';
import type { AccessGrant, SupporterProjection } from '../../supporters/model.js';
import { isTombstone } from '../../supporters/erasure.js';
import { Slug, type Access } from '../model.js';

export const AccessTierKind = z.enum(['free', 'paid']);
export type AccessTierKind = z.infer<typeof AccessTierKind>;

/**
 * What a membership of a paid tier costs per interval, in minor units (brief MY-254 PR 4, choice
 * 9): tenant data, never a price in this repository. An interval without a price is not offered.
 */
export const TierPrices = z
  .object({
    month: z.number().int().min(100).max(1_000_000).optional(),
    year: z.number().int().min(100).max(10_000_000).optional(),
  })
  .strict();
export type TierPrices = z.infer<typeof TierPrices>;

/** The intervals a tier sells, in the order a form offers them. */
export const tierIntervals = (prices: TierPrices): ('month' | 'year')[] =>
  (['month', 'year'] as const).filter((i) => prices[i] !== undefined);

/** A site path of slugs only, like `/word-lid`: no scheme, host, query or `//`. */
export const SitePath = z.string().regex(/^\/[a-z0-9/_-]{0,199}$/);

/**
 * What an update may change: the copy, the order, the prices and the signup page. Slug and kind
 * are fixed at create; only a paid tier has prices.
 */
export const AccessTierInput = z
  .object({
    name: localized(z.string().min(1).max(200)),
    description: localized(z.string().min(1).max(2000)).optional(),
    order: z.number().int().min(0).max(10_000).default(0),
    prices: TierPrices.default({}),
    /** Where a visitor becomes a member; the prompt on a restricted item links here. */
    signupPath: SitePath.nullable().default(null),
  })
  .strict();

const Timestamp = z.string().datetime({ offset: true });

export const AccessTier = AccessTierInput.extend({
  id: z.string().guid(),
  slug: Slug,
  /**
   * `paid`: a membership can buy the tier (ADR 005 rule 8); each paid period is a grant of kind
   * `paid`. A free tier opens only through a comp or gift grant.
   */
  kind: AccessTierKind,
  /** Goes up by one whenever `prices` changes; a membership records the version it pays. */
  priceVersion: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AccessTier = z.infer<typeof AccessTier>;

/** Whether a tier can be bought: paid, with at least one price. */
export const sellable = (tier: Pick<AccessTier, 'kind' | 'prices'>): boolean =>
  tier.kind === 'paid' && tierIntervals(tier.prices).length > 0;

/**
 * The reader as the policy sees them: a supporter of this tenant and their standing grants. The
 * front builds it from the current projection on every request (ADR 019 rule 5), never from a
 * cookie or a payload; null is a visitor without a valid reader identity.
 */
export interface ReaderAccess {
  supporterId: string;
  grants: readonly AccessGrant[];
}

/** The reader of a live projection; an erased supporter is nobody. */
export function readerOf(projection: SupporterProjection | null): ReaderAccess | null {
  if (!projection || isTombstone(projection.email)) return null;
  return { supporterId: projection.id, grants: projection.grants };
}

/**
 * Whether `reader` may read the restricted part of an item with this `access` at `now`. `public`
 * is open; `members` asks for a reader; `tier` asks for a standing grant on one of the item's
 * tiers whose `until` is still ahead: the end is exclusive, so at `until` itself access is over.
 * Everything unreadable is a refusal: a tier item without tier ids, a grant with a broken date.
 */
export function hasAccess(
  reader: ReaderAccess | null,
  item: { access: Pick<Access, 'level' | 'tierIds'> },
  now: Date
): boolean {
  const { level, tierIds } = item.access;
  if (level === 'public') return true;
  if (!reader) return false;
  if (level === 'members') return true;
  if (level !== 'tier' || !tierIds?.length) return false;
  return reader.grants.some((grant) => tierIds.includes(grant.tierId) && grantStands(grant, now));
}

/**
 * When the access `hasAccess` gives at `now` ends by the grants alone: null for one that does not
 * (a `members` item, or an open-ended grant on one of the tiers), else the latest `until` among the
 * standing grants that open the item. Only meaningful where `hasAccess` is true.
 */
export function accessEndsAt(
  reader: ReaderAccess,
  item: { access: Pick<Access, 'level' | 'tierIds'> },
  now: Date
): Date | null {
  if (item.access.level !== 'tier') return null;
  const tierIds = item.access.tierIds ?? [];
  const opening = reader.grants.filter((g) => tierIds.includes(g.tierId) && grantStands(g, now));
  if (opening.some((g) => g.until === null)) return null;
  const ends = opening.map((g) => Date.parse(g.until!));
  return ends.length ? new Date(Math.max(...ends)) : null;
}

/** A grant counts while `now < until`; an open-ended one always. */
export function grantStands(grant: Pick<AccessGrant, 'until'>, now: Date): boolean {
  if (grant.until === null) return true;
  const until = Date.parse(grant.until);
  return !Number.isNaN(until) && now.getTime() < until;
}
