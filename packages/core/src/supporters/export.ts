// The site's supporters as a CSV file (`supporter.export`, TODO MY-256 PR 1): the list an
// administrator has in view, narrowed by the same filter as `supporter.list`, in the same order,
// to take to a spreadsheet or another system. Reading it is `supporters:read`; taking it out is
// the separate `supporters:export` (ADR 018 rule 5), so the command carries the `export` effect,
// leaves an audit row with the hashed filter and the row count, and runs on a suspended site
// (ADR 002 rule 5: leaving is never gated).
//
// The columns are stable keys, not translated labels: a file read by another system must not
// change with the language of whoever downloaded it. Lists are their ids, separated by `; `, the
// way the projection holds them. At most SUPPORTER_EXPORT_MAX rows in one file; a larger list says
// `truncated` and the screen asks for a narrower filter. Rejected: a background export job with a
// download link (what `tenant.export.create` does for the whole site; one list of supporters fits a
// response), and the whole projection with grants and fold position (an internal shape, and
// grants are access, not who someone is).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { csvFile } from '../util/csv.js';
import { STATUS_NEEDS_LIST_ERROR, statusNeedsList, SUPPORTER_FILTER_FIELDS } from './listing.js';
import type { SupporterProjection } from './model.js';
import './ports.js';

/** The most rows one file holds. */
export const SUPPORTER_EXPORT_MAX = 50_000;
/** Rows read per round trip to the repository. */
const BATCH = 1_000;

export const SUPPORTER_EXPORT_COLUMNS = [
  'email',
  'lists',
  'pending_lists',
  'first_seen',
  'last_activity',
  'id',
] as const;

const exportRow = (p: SupporterProjection) => [
  p.email,
  p.lists.join('; '),
  p.pendingLists.join('; '),
  p.firstSeen,
  p.lastActivity,
  p.id,
];

export const exportSupporters = defineUseCase({
  name: 'supporter.export',
  kind: 'command',
  effect: 'export',
  description: `Export the site's supporters as CSV (RFC 4180, CRLF), most recent activity first, with the columns ${SUPPORTER_EXPORT_COLUMNS.join(', ')}; lists are separated by "; ". Narrow with \`list\`, \`status\` (only with \`list\`) and \`q\` (the start of the address), as \`supporter.list\` does. At most ${SUPPORTER_EXPORT_MAX} rows; \`truncated\` says more matched. An erased supporter is never exported.`,
  requires: 'supporters:export',
  input: z
    .object(SUPPORTER_FILTER_FIELDS)
    .strict()
    .refine(statusNeedsList, STATUS_NEEDS_LIST_ERROR),
  output: z.object({
    csv: z.string(),
    rows: z.number().int().min(0),
    /** Every supporter the filter matches, which is more than `rows` when truncated. */
    total: z.number().int().min(0),
    truncated: z.boolean(),
  }),
  examples: [{ input: {} }, { input: { list: 'newsletter', status: 'confirmed' } }],
  async handler(ctx, { list, status, q }) {
    const rows: SupporterProjection[] = [];
    let total = 0;
    let after: { lastActivity: Date; id: string } | null = null;
    while (rows.length < SUPPORTER_EXPORT_MAX) {
      const limit = Math.min(BATCH, SUPPORTER_EXPORT_MAX - rows.length);
      const page = await ctx.supporters.page({ list, status, q }, { after, limit });
      total = page.total;
      rows.push(...page.rows);
      const last = page.rows.at(-1);
      if (page.rows.length < limit || !last) break;
      after = { lastActivity: new Date(last.lastActivity), id: last.id };
    }
    return {
      csv: csvFile(SUPPORTER_EXPORT_COLUMNS, rows.map(exportRow)),
      rows: rows.length,
      total,
      truncated: total > rows.length,
    };
  },
});
