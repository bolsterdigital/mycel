// Presence and the newer-revision notice (ADR 029). One answer for both, so an open screen makes
// one small request per beat. Readable by whoever may read the item (`content:read`), and the
// item is looked up first, so an id of another site is a plain not-found.
//
// `content.presence.update` writes but leaves no audit row (`UNAUDITED_COMMANDS`): the brief asks
// for no audit or retention trail, and one row per open tab every twenty seconds would be exactly
// that trail. Rejected: declaring it a query, which would tell MCP clients a write is read-only.
import { z } from 'zod';
import { auditActor } from '../../audit/model.js';
import { notFound } from '../../errors.js';
import type { TransactionContext } from '../../ports.js';
import { Actor } from '../../principal.js';
import { defineUseCase } from '../../registry.js';
import { exampleId } from '../../util/ids.js';
import { PRESENCE_TTL_MS, PresenceState, type PresenceEntry } from './model.js';

const Id = z.string().guid();

const PresenceView = z.object({
  present: z.array(
    z.object({
      actor: Actor,
      state: PresenceState,
      /** The asker themselves, in another tab or window. */
      self: z.boolean(),
    })
  ),
  /** Set when `baseRevisionId` was given and is no longer the newest revision. */
  newer: z
    .object({
      revisionId: Id,
      actor: Actor,
      createdAt: z.string().datetime({ offset: true }),
    })
    .nullable(),
});
export type PresenceView = z.infer<typeof PresenceView>;

const actorKey = (actor: Actor): string => {
  const { kind, id } = auditActor(actor);
  return `${kind}:${id ?? ''}`;
};

/**
 * One line per actor however many tabs they have open, `editing` if any of them is. Sorted so a
 * screen that redraws every beat does not reshuffle its names. The asker's own tab is left out,
 * their other tabs stay: two windows of one account can overwrite each other too.
 */
export function presentFrom(
  entries: readonly PresenceEntry[],
  asker: Actor,
  ownSession?: string
): PresenceView['present'] {
  const me = actorKey(asker);
  const byActor = new Map<string, PresenceView['present'][number]>();
  for (const entry of entries) {
    if (entry.sessionId === ownSession) continue;
    const key = actorKey(entry.actor);
    const seen = byActor.get(key);
    byActor.set(key, {
      actor: entry.actor,
      state: seen?.state === 'editing' ? 'editing' : entry.state,
      self: key === me,
    });
  }
  return [...byActor.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, line]) => line);
}

async function viewOf(
  ctx: TransactionContext,
  item: { id: string; latestRevisionId: string },
  baseRevisionId: string | undefined,
  ownSession?: string
): Promise<PresenceView> {
  const since = new Date(ctx.clock.now().getTime() - PRESENCE_TTL_MS);
  const entries = await ctx.presence.active(item.id, since);
  const present = presentFrom(entries, ctx.principal.actor, ownSession);
  if (!baseRevisionId || baseRevisionId === item.latestRevisionId) return { present, newer: null };
  const revision = await ctx.content.revision(item.id, item.latestRevisionId);
  if (!revision) throw notFound('revision');
  return {
    present,
    newer: { revisionId: revision.id, actor: revision.actor, createdAt: revision.createdAt },
  };
}

export const updatePresence = defineUseCase({
  name: 'content.presence.update',
  kind: 'command',
  description:
    'Report that this session has an item open, viewing or editing, and read who else has it open. Expires by itself; never blocks anyone.',
  requires: 'content:read',
  input: z.object({
    itemId: Id,
    sessionId: Id,
    state: PresenceState,
    baseRevisionId: Id.optional(),
  }),
  output: PresenceView,
  examples: [{ input: { itemId: exampleId(0x1), sessionId: exampleId(0x2), state: 'viewing' } }],
  async handler(ctx, { itemId, sessionId, state, baseRevisionId }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    await ctx.presence.beat({
      itemId,
      sessionId,
      state,
      actor: ctx.principal.actor,
      lastSeenAt: ctx.clock.now(),
    });
    return viewOf(ctx, item, baseRevisionId, sessionId);
  },
});

export const listPresence = defineUseCase({
  name: 'content.presence.list',
  kind: 'query',
  description:
    'Read who has an item open right now and, given the revision you are working on, whether a newer one exists.',
  requires: 'content:read',
  input: z.object({ itemId: Id, baseRevisionId: Id.optional() }),
  output: PresenceView,
  examples: [{ input: { itemId: exampleId(0x1) } }],
  async handler(ctx, { itemId, baseRevisionId }) {
    const item = await ctx.content.get(itemId);
    if (!item) throw notFound('content item');
    return viewOf(ctx, item, baseRevisionId);
  },
});
