// One supporter as an admin reads them (`supporter.timeline.get`, brief MY-251 PR 2): who they
// are, which lists they are on, which campaigns they took part in, the access they hold and what
// they did, newest first. It reads the projection, the log and the participations that exist
// already and adds no state, under the existing `supporters:read`; an admin screen and an agent
// ask the same question.
//
// An erased supporter is not a supporter (ADR 019 rule 8): a tombstone, or a registered erasure
// that apply has not reached yet, is `not_found`, exactly like an id of another tenant, which
// forced RLS never shows. The timeline carries per event its type, its moment and the three
// references a sentence needs (list, campaign, tier), never the event's props as a whole: those
// hold the reason of an address change and of a grant, the old address and a consent text
// version, which a `supporters:read` key has no use for. The landing page's title comes along
// only for a principal who may read content; a `supporters:read`-only key gets the campaign id.
//
// Rejected: `supporter.get` by id returning the whole log (the props above, and a reader who
// signs in daily has hundreds of events), a repository method that joins participations to the
// supporter (the events already name the campaigns; one read per campaign a person signed is a
// handful), and a cursor over the log (the newest `limit` events and the count answer what a
// screen and an agent ask; older ones are a later item).

import { z } from 'zod';
import '../campaigns/ports.js';
import { CampaignKind } from '../campaigns/model.js';
import '../content/ports.js';
import { notFound } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { can } from '../principal.js';
import { ReaderAccessEntry, accessOf } from '../readers/account.js';
import { defineUseCase } from '../registry.js';
import { exampleId } from '../util/ids.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { isTombstone } from './erasure.js';
import { SupporterEventType, type SupporterEvent } from './events.js';
import { ListedSupporter } from './listing.js';
import { compareFoldPosition, foldPosition } from './model.js';
import './ports.js';

const Timestamp = z.string().datetime({ offset: true });

/** One event as a sentence needs it: what happened, when, and what it was about. */
export const TimelineEntry = z.object({
  id: z.string(),
  type: SupporterEventType,
  occurredAt: Timestamp,
  /** The newsletter list of a signup, a confirmation or a withdrawal. */
  list: z.string().optional(),
  /** False on a signup that still waits for its confirmation link. */
  confirmed: z.boolean().optional(),
  /** The campaign of a signature or a campaign signup. */
  campaignId: z.string().guid().optional(),
  /** The tier of a grant or its withdrawal. */
  tierId: z.string().guid().optional(),
  /** The gift of a donation event, in minor units with its currency (ADR 005 rule 1). */
  amount: z.object({ value: z.number().int().positive(), currency: z.string() }).optional(),
});
export type TimelineEntry = z.infer<typeof TimelineEntry>;

export const SupporterParticipation = z.object({
  campaignId: z.string().guid(),
  kind: CampaignKind,
  confirmedAt: Timestamp,
  /** Set when the participation was withdrawn and no longer counts. */
  withdrawnAt: Timestamp.nullable(),
  /** The landing page, for a principal who may read content; null when it is trashed too. */
  landing: z
    .object({
      itemId: z.string().guid(),
      title: z.record(z.string(), z.string()),
      slug: z.string(),
    })
    .nullable(),
});
export type SupporterParticipation = z.infer<typeof SupporterParticipation>;

export const SupporterTimeline = z.object({
  supporter: ListedSupporter.extend({ lastSeenAt: Timestamp.nullable() }),
  access: z.array(ReaderAccessEntry),
  participations: z.array(SupporterParticipation),
  /** The newest events first, at most `limit`. */
  events: z.array(TimelineEntry),
  /** Every event in the log, whatever `limit`. */
  eventTotal: z.number().int().min(0),
});
export type SupporterTimeline = z.infer<typeof SupporterTimeline>;

const uuid = z.string().guid();

/** The references of one event, each only when it reads as what it should be. */
export function timelineEntry(event: SupporterEvent): TimelineEntry {
  const { list, confirmed, campaign_id: campaign, tier_id: tier, amount, currency } = event.props;
  return {
    id: event.id,
    type: event.type,
    occurredAt: new Date(event.occurred_at).toISOString(),
    ...(typeof list === 'string' ? { list } : {}),
    ...(event.type === 'newsletter.subscribed' ? { confirmed: confirmed !== false } : {}),
    ...(uuid.safeParse(campaign).success ? { campaignId: campaign as string } : {}),
    ...(uuid.safeParse(tier).success ? { tierId: tier as string } : {}),
    ...(event.type.startsWith('donation.') &&
    Number.isInteger(amount) &&
    (amount as number) > 0 &&
    typeof currency === 'string'
      ? { amount: { value: amount as number, currency } }
      : {}),
  };
}

/**
 * The campaigns the events name, each with the supporter's participation as the campaign holds it
 * (ADR 033 rule 7), newest confirmation first. An event without a recorded participation (a
 * campaign of a backfill) lists nothing: the participation is the fact, the event its trace.
 */
async function participationsOf(
  ctx: TransactionContext,
  supporterId: string,
  events: readonly TimelineEntry[]
): Promise<SupporterParticipation[]> {
  const ids = [...new Set(events.flatMap((e) => (e.campaignId ? [e.campaignId] : [])))];
  const mayReadContent = can(ctx.principal, 'content:read');
  const rows: SupporterParticipation[] = [];
  for (const campaignId of ids) {
    const participation = await ctx.campaigns.participation(campaignId, supporterId);
    const campaign = participation && (await ctx.campaigns.get(campaignId));
    if (!participation || !campaign) continue;
    const item = mayReadContent ? await ctx.content.get(campaign.landingItemId) : null;
    rows.push({
      campaignId,
      kind: campaign.kind,
      confirmedAt: new Date(participation.confirmedAt).toISOString(),
      withdrawnAt: participation.withdrawnAt
        ? new Date(participation.withdrawnAt).toISOString()
        : null,
      landing: item ? { itemId: item.id, title: item.title, slug: item.slug } : null,
    });
  }
  return rows.sort(
    (a, b) =>
      Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) ||
      (a.campaignId < b.campaignId ? -1 : 1)
  );
}

export const getSupporterTimeline = defineUseCase({
  name: 'supporter.timeline.get',
  kind: 'query',
  description:
    'Read one supporter by id: e-mail address, confirmed and pending lists, first seen, last activity and last sign-in; the access they hold per tier (also expired); the campaigns they took part in, with the withdrawal if any; and their events newest first (type, moment and the list, campaign or tier it was about), at most `limit` with `eventTotal` for the whole log. An erased supporter is not found.',
  requires: 'supporters:read',
  input: z
    .object({
      supporterId: z.string().guid(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(MAX_PAGE_SIZE),
    })
    .strict(),
  output: SupporterTimeline,
  examples: [{ input: { supporterId: exampleId(0x1) } }],
  async handler(ctx, { supporterId, limit }): Promise<SupporterTimeline> {
    const p = await ctx.supporters.getProjectionById(supporterId);
    if (!p || isTombstone(p.email) || !(await ctx.erasures.allows(p.email, supporterId)))
      throw notFound('supporter');
    // Fold order reversed: the newest moment first, and within one moment the later id first.
    const log = (await ctx.supporters.eventsFor(supporterId))
      .sort((a, b) => compareFoldPosition(foldPosition(b), foldPosition(a)))
      .map(timelineEntry);
    return {
      supporter: {
        id: p.id,
        email: p.email,
        lists: p.lists,
        pendingLists: p.pendingLists,
        firstSeen: p.firstSeen,
        lastActivity: p.lastActivity,
        lastSeenAt: p.lastSeenAt ?? null,
      },
      access: await accessOf(ctx, p, ctx.clock.now()),
      // From the whole log, not the page of it: a signature older than `limit` events still counts.
      participations: await participationsOf(ctx, supporterId, log),
      events: log.slice(0, limit),
      eventTotal: log.length,
    };
  },
});
