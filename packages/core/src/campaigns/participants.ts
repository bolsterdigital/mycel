// Who took part in a campaign (TODO MY-256 PR 2): the confirmed participations of a petition or
// signup with the address of each supporter, a page at a time (`campaign.participation.list`) and
// as a CSV file (`campaign.participation.export`), so an action group can hand a petition over or
// take its signers to another system. The counter (ADR 033 rule 8) says how many; this says who.
//
// These are supporters' addresses, so the campaign's own `content:read` is not enough: the list
// asks `supporters:read` and the file the separate `supporters:export` (ADR 018 rule 5), as
// `supporter.list` and `supporter.export` do. A withdrawn participation stays in both, marked by
// its withdrawal time, because the record of the confirmation stays (rule 7); `active` counts the
// ones that still count. An erased supporter has no row any more (rule 8: the erasure moves it
// into the anonymous count), so the public counter can be higher than `active`. A fundraiser has
// no participation rows: its gifts are payments, listed by `donation.list`, and both use cases
// answer it with an empty list.
//
// Order is the confirmation, newest first, then the higher supporter id, so the order is total and
// a cursor is one row, `<epoch ms>.<supporter id>`, the form `supporter.list` uses. Rejected:
// `supporter.list` with a campaign filter (the projection holds no campaigns, and the date and the
// withdrawal belong to the participation, not the supporter) and the rows on `campaign.get` (it
// would hand addresses to every `content:read`).

import { z } from 'zod';
import { notFound } from '../errors.js';
import { defineUseCase } from '../registry.js';
import { csvFile } from '../util/csv.js';
import { exampleId } from '../util/ids.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { CampaignKind } from './model.js';
import './ports.js';

/** One participation with the supporter it belongs to. */
export const CampaignParticipant = z.object({
  supporterId: z.string().guid(),
  email: z.string().email(),
  confirmedAt: z.string().datetime({ offset: true }),
  /** Set when the supporter withdrew: the participation no longer counts. */
  withdrawnAt: z.string().datetime({ offset: true }).nullable(),
});
export type CampaignParticipant = z.infer<typeof CampaignParticipant>;

/** A point in list order: a participation's confirmation and its supporter. */
export interface ParticipantPosition {
  confirmedAt: Date;
  supporterId: string;
}

export interface ParticipantPage {
  /** At most `limit` rows after `after`, in list order. */
  rows: CampaignParticipant[];
  /** Every participation of the campaign, withdrawn or not. */
  total: number;
  /** The ones that count: confirmed and not withdrawn. */
  active: number;
}

/** List order: negative when `a` comes first. Newest confirmation first, then the higher id. */
export function compareParticipants(a: CampaignParticipant, b: CampaignParticipant): number {
  const byTime = Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt);
  if (byTime !== 0) return byTime;
  return a.supporterId < b.supporterId ? 1 : a.supporterId > b.supporterId ? -1 : 0;
}

/** Whether a participation comes after `position` in list order. */
export const afterParticipant = (p: CampaignParticipant, position: ParticipantPosition) => {
  const at = Date.parse(p.confirmedAt);
  const edge = position.confirmedAt.getTime();
  return at < edge || (at === edge && p.supporterId < position.supporterId);
};

const CURSOR = /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const Cursor = z.string().regex(CURSOR, 'campaign.participation.cursor.invalid');

const cursorOf = (p: CampaignParticipant) => `${Date.parse(p.confirmedAt)}.${p.supporterId}`;

function positionOf(cursor: string): ParticipantPosition {
  const [, ms, id] = CURSOR.exec(cursor)!;
  return { confirmedAt: new Date(Number(ms)), supporterId: id! };
}

const CampaignId = z.string().guid();

export const listParticipations = defineUseCase({
  name: 'campaign.participation.list',
  kind: 'query',
  description:
    'List who took part in a petition or signup, newest confirmation first: supporter id, e-mail address, when the participation was confirmed and, when withdrawn, since when. `total` counts every row, `active` the ones that still count; an erased supporter is in neither, so the public counter can be higher. Pass `next` as `after` for the following page. A fundraiser has no participations (its gifts are under `donation.list`) and answers with an empty list.',
  requires: 'supporters:read',
  input: z
    .object({
      campaignId: CampaignId,
      after: Cursor.optional(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    })
    .strict(),
  output: z.object({
    kind: CampaignKind,
    /** The campaign's page, which holds its title (ADR 033 rule 1). */
    landingItemId: z.string().guid(),
    participants: z.array(CampaignParticipant),
    next: z.string().nullable(),
    total: z.number().int().min(0),
    active: z.number().int().min(0),
  }),
  examples: [{ input: { campaignId: exampleId(0xc1) } }],
  async handler(ctx, { campaignId, after, limit }) {
    const campaign = await ctx.campaigns.get(campaignId);
    if (!campaign) throw notFound('campaign');
    // One row more than asked: its presence is the only sign of a following page.
    const { rows, total, active } = await ctx.campaigns.participants(campaignId, {
      after: after ? positionOf(after) : null,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      kind: campaign.kind,
      landingItemId: campaign.landingItemId,
      participants: page,
      next: rows.length > limit ? cursorOf(page.at(-1)!) : null,
      total,
      active,
    };
  },
});

/** The most rows one file holds, as `supporter.export`. */
export const PARTICIPATION_EXPORT_MAX = 50_000;
/** Rows read per round trip to the repository. */
const BATCH = 1_000;

export const PARTICIPATION_EXPORT_COLUMNS = [
  'email',
  'confirmed_at',
  'withdrawn_at',
  'supporter_id',
] as const;

export const exportParticipations = defineUseCase({
  name: 'campaign.participation.export',
  kind: 'command',
  effect: 'export',
  description: `Export who took part in a petition or signup as CSV (RFC 4180, CRLF), newest confirmation first, with the columns ${PARTICIPATION_EXPORT_COLUMNS.join(', ')}; \`withdrawn_at\` is empty for a participation that counts. At most ${PARTICIPATION_EXPORT_MAX} rows; \`truncated\` says the campaign has more. An erased supporter is never exported; a fundraiser gives a file with the header only.`,
  requires: 'supporters:export',
  input: z.object({ campaignId: CampaignId }).strict(),
  output: z.object({
    csv: z.string(),
    rows: z.number().int().min(0),
    /** Every participation of the campaign, which is more than `rows` when truncated. */
    total: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  examples: [{ input: { campaignId: exampleId(0xc1) } }],
  async handler(ctx, { campaignId }) {
    if (!(await ctx.campaigns.get(campaignId))) throw notFound('campaign');
    const rows: CampaignParticipant[] = [];
    let total = 0;
    let after: ParticipantPosition | null = null;
    while (rows.length < PARTICIPATION_EXPORT_MAX) {
      const limit = Math.min(BATCH, PARTICIPATION_EXPORT_MAX - rows.length);
      const page = await ctx.campaigns.participants(campaignId, { after, limit });
      total = page.total;
      rows.push(...page.rows);
      const last = page.rows.at(-1);
      if (page.rows.length < limit || !last) break;
      after = { confirmedAt: new Date(last.confirmedAt), supporterId: last.supporterId };
    }
    return {
      csv: csvFile(
        PARTICIPATION_EXPORT_COLUMNS,
        rows.map((p) => [p.email, p.confirmedAt, p.withdrawnAt ?? '', p.supporterId])
      ),
      rows: rows.length,
      total,
      truncated: total > rows.length,
    };
  },
});
