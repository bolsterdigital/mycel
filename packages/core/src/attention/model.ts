// What asks for attention in the admin (decided 2026-11-06). A notification is a view on a truth
// that already exists (a job out of attempts, mail given up, a late erasure, a connection in
// `attention`), never a row of its own: once the problem is solved it disappears without anyone
// marking it. Read state is one moment per member, `seenAt`; a notification is unread when its
// `since` is later. Rejected: a stored notification per member per event (fan-out, a second truth
// beside the status page, rows to clean up) and read state per notification (no row to mark for a
// derived item, for a difference nobody notices on a handful per site; the `key` keeps that open).

import { z } from 'zod';
import type { Capability } from '../principal.js';
import { iso } from '../util/date.js';

const Timestamp = z.string().datetime({ offset: true });

/** Where a notification comes from; `review` is a locale offered for publication. */
export const AttentionSource = z.enum(['job', 'mail', 'erasure', 'connection', 'review']);
export type AttentionSource = z.infer<typeof AttentionSource>;

/**
 * Who sees a source: the capability it takes to act on it. Filtered in core, so the admin, the API
 * and MCP give one answer (ADR 009). The first four are the status page's and the connections'
 * work, which only an administrator can do something about; an offer is for whoever may publish.
 */
export const SOURCE_CAPABILITY: Readonly<Record<AttentionSource, Capability>> = {
  job: 'tenant:admin',
  mail: 'tenant:admin',
  erasure: 'tenant:admin',
  connection: 'tenant:admin',
  review: 'content:publish',
};

export const AttentionItem = z.object({
  /** `<source>:<id>` for one thing, `<source>` for a count over many; stable while it lasts. */
  key: z.string(),
  source: AttentionSource,
  /** The job, connection or content item it is about; null for a count (mail, erasures). */
  subjectId: z.string().guid().nullable(),
  /** The locale an offer is for; null for every other source. */
  locale: z.string().nullable(),
  /**
   * The job type, the connection's provider or the offered item's title: enough to recognise it,
   * never a payload.
   */
  detail: z.string().nullable(),
  /** How many things this one notification stands for; 1 for a single job or connection. */
  count: z.number().int().positive(),
  /** Since when it asks: the newest reason, so a new failure is news again. */
  since: Timestamp,
  unread: z.boolean(),
});
export type AttentionItem = z.infer<typeof AttentionItem>;

export const AttentionSourceCount = z.object({
  source: AttentionSource,
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
});

export const AttentionSummary = z.object({
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  /** Per source this member sees, also at zero, in `AttentionSource` order. */
  sources: z.array(AttentionSourceCount),
  /** Null for an API key or agent (no membership to remember it) and before the first read. */
  seenAt: Timestamp.nullable(),
});
export type AttentionSummary = z.infer<typeof AttentionSummary>;

/** Unread when it began asking after the member last read the list; all unread before that. */
export const isUnread = (since: Date, seenAt: Date | null): boolean =>
  seenAt === null || since.getTime() > seenAt.getTime();

/** Counts per source the member sees, including zeros, so a front can show "nothing" per kind. */
export function summarise(
  items: readonly AttentionItem[],
  visible: readonly AttentionSource[],
  seenAt: Date | null
): AttentionSummary {
  const sources = visible.map((source) => {
    const mine = items.filter((i) => i.source === source);
    return { source, total: mine.length, unread: mine.filter((i) => i.unread).length };
  });
  return {
    total: items.length,
    unread: items.filter((i) => i.unread).length,
    sources,
    seenAt: iso(seenAt),
  };
}
