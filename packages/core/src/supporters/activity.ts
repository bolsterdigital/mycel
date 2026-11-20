// How a site grew lately (`supporter.activity.get`, MY-259 PR 1): who joined and who left a
// list, and who took part in a campaign, in the last 30 days of the site's calendar and the 30
// before, per list, per campaign and per day. It is what the dashboard's "Sign-ups" widget shows
// and what an agent asks under the same `supporters:read`. It counts people, never names them:
// the answer holds lists, campaign ids and titles and numbers, no address and no supporter id
// (ADR 019 rule 7).
//
// The sources are the ones that exist: the supporter log (ADR 003 rule 1) for list joins and
// leaves, and the participations (ADR 033 rule 7) for campaigns. The ports hand over the bare
// changes in the window and the counting rules live here once, so the memory adapter and
// Postgres cannot count differently. A join is a confirmed `newsletter.subscribed` (absent
// `confirmed` reads as confirmed, as in the projection) or a `consent.given`; one person counts
// once per list and window, on the day of their first join in it. An erased supporter's events
// name no list any more and its participations are gone, so it drops out by itself. A
// participation counts while it is not withdrawn.
//
// Rejected: a dashboard use case over every domain (it would need every capability at once), a
// stored counter table (a second source that drifts from the log), and grouping in SQL (the same
// rules twice); a site's two months of changes fit a request, and a busier site is a later note.

import { z } from 'zod';
import '../campaigns/ports.js';
import { CampaignKind } from '../campaigns/model.js';
import '../content/ports.js';
import { can } from '../principal.js';
import { defineUseCase } from '../registry.js';
import type { SupporterEvent } from './events.js';
import { DEFAULT_TIME_ZONE, IanaTimeZone, localDate, startOfLocalDay } from '../util/time-zone.js';
import './ports.js';

/** The days a window spans, today included. */
export const ACTIVITY_DAYS = 30;
const DAY_MS = 86_400_000;

/** A list join or leave as the summary needs it: who (an id, never shown), which list, when. */
export interface ListChange {
  supporterId: string;
  list: string;
  kind: 'joined' | 'left';
  at: string;
}

/** An active participation as the summary needs it. */
export interface ParticipationChange {
  campaignId: string;
  supporterId: string;
  at: string;
}

/** The list change an event is, or null (the memory adapter's rule; Postgres states it in SQL). */
export function listChangeOf(event: SupporterEvent): ListChange | null {
  const list = event.props['list'];
  if (typeof list !== 'string' || !event.supporter_id) return null;
  const change = { supporterId: event.supporter_id, list, at: event.occurred_at };
  if (event.type === 'consent.given') return { ...change, kind: 'joined' };
  if (event.type === 'newsletter.subscribed')
    return event.props['confirmed'] === false ? null : { ...change, kind: 'joined' };
  if (event.type === 'newsletter.unsubscribed' || event.type === 'consent.withdrawn')
    return { ...change, kind: 'left' };
  return null;
}

/** `date` (YYYY-MM-DD) moved by `days` on the calendar, without a clock or a zone. */
const shiftDate = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** The window ending at `until`: its first day, its start and the start of the one before. */
export function activityWindow(until: Date, zone: string) {
  const today = localDate(until, zone);
  const first = shiftDate(today, -(ACTIVITY_DAYS - 1));
  return {
    dates: Array.from({ length: ACTIVITY_DAYS }, (_, i) => shiftDate(first, i)),
    from: startOfLocalDay(first, zone),
    previousFrom: startOfLocalDay(shiftDate(first, -ACTIVITY_DAYS), zone),
  };
}

const Count = z.number().int().nonnegative();

export const SupporterActivity = z.object({
  /** The start of the 30 days, the moment they end and the zone their days follow. */
  from: z.string().datetime({ offset: true }),
  until: z.string().datetime({ offset: true }),
  timeZone: z.string(),
  /** People who joined a list, once per list; the same for the 30 days before. */
  joined: Count,
  joinedBefore: Count,
  /** People who left a list, once per list. */
  left: Count,
  /** Active campaign participations confirmed in the window; the same for the 30 days before. */
  participations: Count,
  participationsBefore: Count,
  /** Every day of the window, oldest first. */
  days: z.array(z.object({ date: z.string(), joined: Count, participations: Count })),
  /** Lists with a join or leave in either window, most joins first, then by name. */
  lists: z.array(
    z.object({
      list: z.string(),
      joined: Count,
      joinedBefore: Count,
      left: Count,
      /** Confirmed members now. */
      members: Count,
    })
  ),
  /** Campaigns with a participation in either window, most first. */
  campaigns: z.array(
    z.object({
      id: z.string().guid(),
      kind: CampaignKind,
      /** The landing page's title per locale; null without `content:read` or when trashed. */
      title: z.record(z.string(), z.string()).nullable(),
      participations: Count,
      participationsBefore: Count,
    })
  ),
});
export type SupporterActivity = z.infer<typeof SupporterActivity>;

export const getSupporterActivity = defineUseCase({
  name: 'supporter.activity.get',
  kind: 'query',
  requires: 'supporters:read',
  description:
    "How the site grew lately: people who joined or left a list and campaign participations in the last 30 days of the site's calendar (today included) and in the 30 days before, per list, per campaign and per day. Numbers only, no addresses. `timeZone` decides where a day starts (default Europe/Amsterdam); `until` ends the window at another moment than now.",
  input: z
    .object({
      timeZone: IanaTimeZone.default(DEFAULT_TIME_ZONE),
      until: z.string().datetime({ offset: true }).optional(),
    })
    .strict(),
  output: SupporterActivity,
  examples: [{ input: {} }, { input: { timeZone: 'Europe/Berlin' } }],
  async handler(ctx, { timeZone, until: end }) {
    const until = end ? new Date(end) : ctx.clock.now();
    const { dates, from, previousFrom } = activityWindow(until, timeZone);
    const inWindow = (at: string) => Date.parse(at) >= from.getTime();
    const day = new Map(dates.map((d) => [d, { date: d, joined: 0, participations: 0 }]));

    // One person once per list and window, on the day of the first join; changes come oldest first.
    const lists = new Map<
      string,
      { joined: Set<string>; before: Set<string>; left: Set<string> }
    >();
    for (const c of await ctx.supporters.listChanges(previousFrom, until)) {
      const row = lists.get(c.list) ?? { joined: new Set(), before: new Set(), left: new Set() };
      lists.set(c.list, row);
      const current = inWindow(c.at);
      if (c.kind === 'left') {
        if (current) row.left.add(c.supporterId);
      } else if (!current) row.before.add(c.supporterId);
      else if (!row.joined.has(c.supporterId)) {
        row.joined.add(c.supporterId);
        const bucket = day.get(localDate(new Date(c.at), timeZone));
        if (bucket) bucket.joined += 1;
      }
    }

    const campaigns = new Map<string, { now: number; before: number }>();
    for (const p of await ctx.campaigns.participationsSince(previousFrom, until)) {
      const row = campaigns.get(p.campaignId) ?? { now: 0, before: 0 };
      campaigns.set(p.campaignId, row);
      if (!inWindow(p.at)) row.before += 1;
      else {
        row.now += 1;
        const bucket = day.get(localDate(new Date(p.at), timeZone));
        if (bucket) bucket.participations += 1;
      }
    }

    const listRows = [];
    for (const [list, row] of lists)
      listRows.push({
        list,
        joined: row.joined.size,
        joinedBefore: row.before.size,
        left: row.left.size,
        members: await ctx.supporters.countMembers(list),
      });
    listRows.sort((a, b) => b.joined - a.joined || a.list.localeCompare(b.list));

    // One read per campaign with a participation: a site runs tens of campaigns, not thousands.
    const readsContent = can(ctx.principal, 'content:read');
    const campaignRows = [];
    for (const [id, row] of campaigns) {
      const campaign = await ctx.campaigns.get(id);
      if (!campaign) continue;
      const landing = readsContent ? await ctx.content.get(campaign.landingItemId) : null;
      campaignRows.push({
        id,
        kind: campaign.kind,
        title: landing?.title ?? null,
        participations: row.now,
        participationsBefore: row.before,
      });
    }
    campaignRows.sort((a, b) => b.participations - a.participations || a.id.localeCompare(b.id));

    const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((n, r) => n + f(r), 0);
    return {
      from: from.toISOString(),
      until: until.toISOString(),
      timeZone,
      joined: sum(listRows, (r) => r.joined),
      joinedBefore: sum(listRows, (r) => r.joinedBefore),
      left: sum(listRows, (r) => r.left),
      participations: sum(campaignRows, (r) => r.participations),
      participationsBefore: sum(campaignRows, (r) => r.participationsBefore),
      days: [...day.values()],
      lists: listRows,
      campaigns: campaignRows,
    };
  },
});
