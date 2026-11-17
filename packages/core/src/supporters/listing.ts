// The list of a site's supporters (`supporter.list`): who they are, narrowed to a list and to an
// address, a page at a time. It reads the projection only (ADR 003 rule 3) and adds no state, so
// an admin screen and an agent ask the same question under the existing `supporters:read`. The
// rules live here once: the memory adapter runs these functions as written, the Postgres adapter
// states the same rules in SQL, and one scenario in `packages/db/src/adapter-rules.test.ts`
// (`supporters/list-rule.ts`) holds the two to one answer.
//
// An erased supporter is not a supporter: the projection row stays under its tombstone address
// (ADR 019 rule 8) and no list shows it, with or without a filter. Order is last activity, newest
// first, then id descending, so every order is total and a cursor is one row,
// `<epoch ms>.<supporter id>`. The search is the start of the normalised address, never a
// substring: a start can use the address index, and "everyone at example.org" is a segment, which
// is a later item. Rejected: an offset (a new signup shifts every page while someone reads), a
// search in core over all rows (a site's supporters do not fit a request), and logging the
// search term (it is part of an address, ADR 019 rule 7).

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { normalizeEmail } from '../util/email.js';
import { MAX_PAGE_SIZE } from '../util/page-size.js';
import { isTombstone } from './erasure.js';
import type { SupporterProjection } from './model.js';
import './ports.js';

export const SupporterListStatus = z.enum(['confirmed', 'pending']);
export type SupporterListStatus = z.infer<typeof SupporterListStatus>;

export interface SupporterFilter {
  /** On this list: confirmed or pending, unless `status` narrows it. */
  list?: string | undefined;
  /** Only with `list`. */
  status?: SupporterListStatus | undefined;
  /** The start of the address, already normalised. */
  q?: string | undefined;
}

/** A point in list order: a supporter's last activity and id. */
export interface SupporterPosition {
  lastActivity: Date;
  id: string;
}

export interface SupporterPage {
  /** At most `limit` rows after `after`, in list order. */
  rows: SupporterProjection[];
  /** Every supporter the filter matches, whatever the page. */
  total: number;
}

export function matchesSupporterFilter(p: SupporterProjection, filter: SupporterFilter): boolean {
  if (isTombstone(p.email)) return false;
  if (filter.q && !p.email.startsWith(filter.q)) return false;
  if (!filter.list) return true;
  const confirmed = p.lists.includes(filter.list);
  const pending = p.pendingLists.includes(filter.list);
  if (filter.status === 'confirmed') return confirmed;
  if (filter.status === 'pending') return pending;
  return confirmed || pending;
}

/** List order: negative when `a` comes first. Newest activity first, then the higher id. */
export function compareSupporters(a: SupporterProjection, b: SupporterProjection): number {
  const byTime = Date.parse(b.lastActivity) - Date.parse(a.lastActivity);
  if (byTime !== 0) return byTime;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether a supporter comes after `position` in list order. */
export const afterPosition = (p: SupporterProjection, position: SupporterPosition): boolean => {
  const at = Date.parse(p.lastActivity);
  const edge = position.lastActivity.getTime();
  return at < edge || (at === edge && p.id < position.id);
};

/** Epoch milliseconds and a lowercase uuid, the form both adapters write and order by. */
const SUPPORTER_CURSOR =
  /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const SupporterCursor = z.string().regex(SUPPORTER_CURSOR, 'supporter.list.cursor.invalid');

export const supporterCursor = (p: Pick<SupporterProjection, 'lastActivity' | 'id'>): string =>
  `${Date.parse(p.lastActivity)}.${p.id}`;

function positionOf(cursor: string): SupporterPosition {
  const [, ms, id] = SUPPORTER_CURSOR.exec(cursor)!;
  return { lastActivity: new Date(Number(ms)), id: id! };
}

/** One row of the list: the projection without its grants and fold position. */
export const ListedSupporter = z.object({
  id: z.string().guid(),
  email: z.string().email(),
  /** Lists with confirmed consent. */
  lists: z.array(z.string()),
  /** Lists signed up for but not yet confirmed. */
  pendingLists: z.array(z.string()),
  firstSeen: z.string().datetime({ offset: true }),
  lastActivity: z.string().datetime({ offset: true }),
});
export type ListedSupporter = z.infer<typeof ListedSupporter>;

export const listSupporters = defineUseCase({
  name: 'supporter.list',
  kind: 'query',
  description:
    "List the site's supporters, most recent activity first: id, e-mail address, confirmed and pending lists, first seen and last activity. Narrow with `list` (on that list, confirmed or pending), `status` (`confirmed` or `pending`, only with `list`) and `q` (the start of the address). Pass `next` as `after` for the following page; `total` counts every match. An erased supporter is never listed.",
  requires: 'supporters:read',
  input: z
    .object({
      list: z.string().trim().min(1).max(100).optional(),
      status: SupporterListStatus.optional(),
      q: z.string().trim().min(1).max(254).transform(normalizeEmail).optional(),
      after: SupporterCursor.optional(),
      limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    })
    .strict()
    .refine((input) => !input.status || input.list, {
      message: 'supporter.list.status.needs-list',
      path: ['status'],
    }),
  output: z.object({
    supporters: z.array(ListedSupporter),
    next: z.string().nullable(),
    total: z.number().int().min(0),
  }),
  examples: [{ input: {} }, { input: { list: 'newsletter', status: 'confirmed', limit: 20 } }],
  async handler(ctx, { list, status, q, after, limit }) {
    // One row more than asked: its presence is the only sign of a following page.
    const { rows, total } = await ctx.supporters.page(
      { list, status, q },
      { after: after ? positionOf(after) : null, limit: limit + 1 }
    );
    const page = rows.slice(0, limit);
    return {
      supporters: page.map((p) => ({
        id: p.id,
        email: p.email,
        lists: p.lists,
        pendingLists: p.pendingLists,
        firstSeen: p.firstSeen,
        lastActivity: p.lastActivity,
      })),
      next: rows.length > limit ? supporterCursor(page.at(-1)!) : null,
      total,
    };
  },
});
