// A membership is a subscription of kind `membership` that buys a paid access tier (ADR 005 rule
// 8, ADR 016 rule 2, brief MY-254 PR 4). It charges like a monthly gift; what differs is what a
// paid period gives and what the giver's log says:
//
// - Every paid period writes `access.granted` with kind `paid` for the tier, until `paidThrough`
//   plus the grace of the dunning policy (choice 8). `hasAccess` keeps reading one source, the
//   standing grant, and compares its `until` with the clock at each read (ADR 019 rule 4): nothing
//   expires a member, and a member whose charge failed keeps reading through the grace while the
//   dunning runs.
// - The log says `membership.started`, `membership.renewed` and `membership.ended` (choice 15)
//   instead of the `donation.subscription.*` events of a gift.
// - Cancelling stops at the end of the paid period (choice 10): the subscription keeps
//   `cancelAtPeriodEnd` and the charge run ends it at `paidThrough`; the last grant stands until
//   `paidThrough` plus grace, so access ends on its own and nothing revokes it.
//
// This file imports nothing from `subscription-steps.ts` or `service.ts`; they call it.
// Rejected: revoking the grant when a membership ends (a member who cancels has paid for the rest
// of the period, and the grant's `until` already says when it ends), and `hasAccess` reading the
// subscriptions (two sources for one decision, and a second path for an erasure to clear).

import { sellable, tierIntervals, type AccessTier } from '../content/access/model.js';
import '../content/ports.js';
import { UseCaseError } from '../errors.js';
import type { FormDefinition } from '../forms/model.js';
import type { TransactionContext } from '../ports.js';
import { isTombstone } from '../supporters/erasure.js';
import { SupporterEvent } from '../supporters/events.js';
import { SOURCE, appendAndFold } from '../supporters/service.js';
import '../supporters/ports.js';
import { sha1Hex } from '../util/digest.js';
import { DEFAULT_DUNNING, type Subscription } from './subscription-model.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Until when a paid period gives access: `paidThrough` plus the grace (exclusive end). */
export function accessUntil(paidThrough: string): string {
  return new Date(Date.parse(paidThrough) + DEFAULT_DUNNING.graceDays * DAY_MS).toISOString();
}

export type MembershipEvent = 'membership.started' | 'membership.renewed' | 'membership.ended';

/**
 * Append `type` to the member's log, and for a started or renewed membership the `paid` grant for
 * its period. The caller holds the member's address lock; an erased or unknown member gets
 * nothing, and a membership without a tier or a paid period grants nothing.
 */
export async function appendMembershipEvent(
  ctx: TransactionContext,
  sub: Subscription,
  type: MembershipEvent,
  extra: Record<string, unknown> = {}
): Promise<void> {
  if (!sub.supporterId || !sub.tierId) return;
  const p = await ctx.supporters.getProjectionById(sub.supporterId);
  if (!p || isTombstone(p.email) || !(await ctx.erasures.allows(p.email, p.id))) return;
  const at = ctx.clock.now().toISOString();
  const ref = `subscription:${sub.id}`;
  const append = async (eventType: string, props: Record<string, unknown>) =>
    appendAndFold(ctx, {
      ...SupporterEvent.parse({
        schema: 'wings.supporter-event.v1',
        id: await sha1Hex([SOURCE, ref, eventType, at].join('|')),
        type: eventType,
        email: p.email,
        occurred_at: at,
        source: SOURCE,
        source_site: 'urn:mycel:money',
        source_ref: ref,
        props,
      }),
      supporter_id: p.id,
    });
  await append(type, {
    subscription_id: sub.id,
    tier_id: sub.tierId,
    amount: sub.amount,
    currency: sub.currency,
    interval: sub.interval,
    paid_through: sub.paidThrough,
    ...extra,
  });
  if (type !== 'membership.ended' && sub.paidThrough)
    await append('access.granted', {
      tier_id: sub.tierId,
      kind: 'paid',
      until: accessUntil(sub.paidThrough),
      subscription_id: sub.id,
    });
}

/** The name under which a membership form posts the interval chosen (no field name has a hyphen). */
export const MEMBERSHIP_INTERVAL = 'membership-interval';

/** What a visitor buys on a membership form: the tier, the version of its price, and the price. */
export interface MembershipChoice {
  tierId: string;
  version: number;
  interval: 'month' | 'year';
  price: number;
  name: AccessTier['name'];
  slug: string;
}

/**
 * The membership a post to `form` buys: the tier the form binds, the interval posted as
 * `membership-interval` (the first the tier sells when nothing was posted), and the tier's price
 * for it now. `{ invalid }` for an interval the tier does not sell. Throws `conflict` when the
 * tier is gone or sells nothing: the form cannot take a member, whatever was posted.
 */
export async function membershipOf(
  ctx: TransactionContext,
  form: Pick<FormDefinition, 'tierId'>,
  raw: Readonly<Record<string, unknown>>
): Promise<MembershipChoice | { invalid: true }> {
  const tier = form.tierId ? await ctx.accessTiers.get(form.tierId) : null;
  if (!tier || !sellable(tier))
    throw new UseCaseError('conflict', 'the tier of this form sells no membership');
  const offered = tierIntervals(tier.prices);
  const posted = raw[MEMBERSHIP_INTERVAL];
  const interval =
    posted === undefined || posted === '' ? offered[0]! : offered.find((i) => i === posted);
  if (!interval) return { invalid: true };
  return {
    tierId: tier.id,
    version: tier.priceVersion,
    interval,
    price: tier.prices[interval]!,
    name: tier.name,
    slug: tier.slug,
  };
}
