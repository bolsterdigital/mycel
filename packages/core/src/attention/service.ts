// The attention use cases: one list, one count for the bell, and the member's
// "read up to here". Each source reads through the port its own page already uses, so the status
// page, the connections and this list cannot disagree, and a source the member may not see is not
// read at all. The cost is a fixed number of reads per call (at most one per port), whatever the
// number of jobs or connections; `ConnectionIntents.recent` is the one read added for it.
// Rejected: reusing `ops.status.get` for the bell (it also reads fourteen days of mail, audit rows
// and builds a diagnosis on every page load) and a source registry other modules plug into (five
// sources, all known here).

import { z } from 'zod';
import '../connections/ports.js';
import '../content/ports.js';
import { attentionSince, STAND_INTENTS } from '../connections/stand.js';
import type { ConnectionIntent } from '../connections/intents.js';
import '../mailing/ports.js';
import '../ops/ports.js';
import type { TransactionContext } from '../ports.js';
import { notFound } from '../errors.js';
import { can } from '../principal.js';
import { defineUseCase } from '../registry.js';
import { ERASURE_UNSECURED_WARN_MS } from '../supporters/erasure.js';
import '../supporters/ports.js';
import {
  AttentionItem,
  AttentionSource,
  AttentionSummary,
  SOURCE_CAPABILITY,
  isUnread,
  summarise,
} from './model.js';
import './ports.js';

/** At most this many jobs on the list, as on the status page; as many offers. */
const ATTENTION_JOBS = 100;
const ATTENTION_OFFERS = 100;

type Found = Omit<AttentionItem, 'since' | 'unread'> & { since: Date };

async function jobs(ctx: TransactionContext): Promise<Found[]> {
  return (await ctx.jobRecovery.exhausted(ATTENTION_JOBS)).map((j) => ({
    key: `job:${j.id}`,
    source: 'job',
    subjectId: j.id,
    locale: null,
    detail: j.type,
    count: 1,
    since: j.failedAt ?? j.createdAt,
  }));
}

async function mail(ctx: TransactionContext, now: Date): Promise<Found[]> {
  const abandoned = (await ctx.mailSends.unresolved(now)).flatMap((m) =>
    m.abandonedAt ? [m.abandonedAt] : []
  );
  if (!abandoned.length) return [];
  const since = new Date(Math.max(...abandoned.map((at) => at.getTime())));
  return [
    {
      key: 'mail',
      source: 'mail',
      subjectId: null,
      locale: null,
      detail: null,
      count: abandoned.length,
      since,
    },
  ];
}

async function erasures(ctx: TransactionContext, now: Date): Promise<Found[]> {
  const { registered, secured, oldestUnsecuredAt: oldest } = await ctx.erasures.status();
  if (oldest === null || now.getTime() - oldest.getTime() <= ERASURE_UNSECURED_WARN_MS) return [];
  // Late from the moment the warning applies, as `judgeOps` counts it.
  const since = new Date(oldest.getTime() + ERASURE_UNSECURED_WARN_MS);
  return [
    {
      key: 'erasure',
      source: 'erasure',
      subjectId: null,
      locale: null,
      detail: null,
      count: registered - secured,
      since,
    },
  ];
}

async function connections(ctx: TransactionContext): Promise<Found[]> {
  const [list, recent] = await Promise.all([
    ctx.connections.list(),
    ctx.connectionIntents.recent(STAND_INTENTS),
  ]);
  const byConnection = new Map<string, ConnectionIntent[]>();
  for (const i of recent)
    byConnection.set(i.connectionId, [...(byConnection.get(i.connectionId) ?? []), i]);
  return list.flatMap((c) => {
    const since = attentionSince(
      {
        state: c.state,
        credentialStatus: c.hasCredential ? 'connected' : 'reconnect-required',
        updatedAt: c.updatedAt,
      },
      byConnection.get(c.id) ?? []
    );
    return since
      ? [
          {
            key: `connection:${c.id}`,
            source: 'connection' as const,
            subjectId: c.id,
            locale: null,
            detail: c.provider,
            count: 1,
            since,
          },
        ]
      : [];
  });
}

/** One notification per offered locale, dated by the first offer (`requestReview`). */
async function reviews(ctx: TransactionContext): Promise<Found[]> {
  return (await ctx.content.offeredForReview(ATTENTION_OFFERS)).map((o) => ({
    key: `review:${o.itemId}:${o.locale}`,
    source: 'review',
    subjectId: o.itemId,
    locale: o.locale,
    detail: o.title,
    count: 1,
    since: o.since,
  }));
}

/** The sources this principal sees, in `AttentionSource` order. */
const visibleSources = (ctx: TransactionContext): AttentionSource[] =>
  AttentionSource.options.filter((s) => can(ctx.principal, SOURCE_CAPABILITY[s]));

const operatorId = (ctx: TransactionContext): string | null =>
  ctx.principal.actor.kind === 'operator' ? ctx.principal.actor.operatorId : null;

/** Everything this principal sees, newest first, with its read state. */
async function collect(
  ctx: TransactionContext
): Promise<{ items: AttentionItem[]; visible: AttentionSource[]; seenAt: Date | null }> {
  const now = ctx.clock.now();
  const visible = visibleSources(ctx);
  const read: Record<AttentionSource, () => Promise<Found[]>> = {
    job: () => jobs(ctx),
    mail: () => mail(ctx, now),
    erasure: () => erasures(ctx, now),
    connection: () => connections(ctx),
    review: () => reviews(ctx),
  };
  const member = operatorId(ctx);
  const [seenAt, ...found] = await Promise.all([
    member ? ctx.attentionReads.seenAt(member) : Promise.resolve(null),
    ...visible.map((s) => read[s]()),
  ]);
  const items = found
    .flat()
    .sort((a, b) => b.since.getTime() - a.since.getTime() || a.key.localeCompare(b.key))
    .map((f) => ({ ...f, since: f.since.toISOString(), unread: isUnread(f.since, seenAt) }));
  return { items, visible, seenAt };
}

// Every member reads its own list: each preset role holds `content:read`, and what the list holds
// is filtered per source above. A custom set without it sees no bell, which the admin treats as
// zero. Rejected: `tenant:admin` for the list, which an editor with offers to publish would fail.

export const getAttentionSummary = defineUseCase({
  name: 'attention.summary.get',
  kind: 'query',
  description:
    'Count what asks for attention on this site that you may act on, in total and per source, and how much of it is new since you last read the list.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: AttentionSummary,
  examples: [{ input: {} }],
  async handler(ctx) {
    const { items, visible, seenAt } = await collect(ctx);
    return summarise(items, visible, seenAt);
  },
});

export const listAttention = defineUseCase({
  name: 'attention.list',
  kind: 'query',
  description:
    'List what asks for attention on this site that you may act on, newest first: jobs out of attempts, mail given up, late erasures, connections that need work and drafts offered for publication, each marked new or already read. A solved problem leaves the list by itself.',
  requires: 'content:read',
  input: z.object({}).strict(),
  output: z.object({
    items: z.array(AttentionItem),
    summary: AttentionSummary,
  }),
  examples: [{ input: {} }],
  async handler(ctx) {
    const { items, visible, seenAt } = await collect(ctx);
    return { items, summary: summarise(items, visible, seenAt) };
  },
});

export const updateAttentionSeenAt = defineUseCase({
  name: 'attention.seen_at.update',
  kind: 'command',
  description:
    'Mark the attention list as read up to the moment it was shown, so only what arrives later counts as new. The moment never moves back.',
  requires: 'content:read',
  // Read state belongs to a person's membership; a key or agent has none to keep it in.
  actors: ['operator'],
  input: z
    .object({
      /** When the list was shown; something that arrived after it stays new. Capped at now. */
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  output: z.object({ seenAt: z.string().datetime({ offset: true }) }),
  examples: [{ input: { at: '2026-11-06T09:00:00.000Z' } }],
  async handler(ctx, { at }) {
    const now = ctx.clock.now();
    const shown = new Date(Math.min(Date.parse(at), now.getTime()));
    const member = operatorId(ctx);
    const stored = member ? await ctx.attentionReads.markSeen(member, shown) : null;
    if (!stored) throw notFound('membership', 'this operator');
    return { seenAt: stored.toISOString() };
  },
});
