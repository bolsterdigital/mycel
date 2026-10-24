// The tenant's own audit log, for its administrators (brief #17b decision 7). The input hash is
// left out: it is for support with the key, not for the reader. Writing is not here: the Invoker
// records every command itself (invoke.ts), so no use case can forget it.

import { z } from 'zod';
import { defineUseCase } from '../registry.js';
import { AuditActorKind, type AuditEntry } from './model.js';
import './ports.js';

const AuditId = z.string().guid();

export const AuditRow = z.object({
  id: AuditId,
  occurredAt: z.string().datetime({ offset: true }),
  actorKind: AuditActorKind,
  actorId: z.string().nullable(),
  operation: z.string(),
  effect: z.string().nullable(),
  result: z.string(),
  requestId: z.string().nullable(),
  subjectId: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRow>;

/** A row as an administrator reads it: everything but the input hash. */
export const toAuditRow = (r: AuditEntry): AuditRow => ({
  id: r.id,
  occurredAt: r.occurredAt.toISOString(),
  actorKind: r.actorKind,
  actorId: r.actorId,
  operation: r.operation,
  effect: r.effect,
  result: r.result,
  requestId: r.requestId,
  subjectId: r.subjectId,
});

export const listAudit = defineUseCase({
  name: 'audit.list',
  kind: 'query',
  description:
    'List the actions taken on this site, newest first, a page at a time: who did what and how it ended.',
  requires: 'tenant:admin',
  input: z
    .object({
      /** Inclusive lower bound of `occurredAt`. */
      from: z.string().datetime({ offset: true }).optional(),
      /** Exclusive upper bound of `occurredAt`. */
      to: z.string().datetime({ offset: true }).optional(),
      operation: z.string().min(1).max(100).optional(),
      actorKind: AuditActorKind.optional(),
      actorId: z.string().min(1).max(200).optional(),
      cursor: AuditId.optional(),
      /** Default 50. */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .strict(),
  output: z.object({ items: z.array(AuditRow), nextCursor: AuditId.nullable() }),
  examples: [{ input: {} }, { input: { operation: 'media.upload', limit: 10 } }],
  async handler(ctx, { from, to, operation, actorKind, actorId, cursor, limit = 50 }) {
    const rows = await ctx.audit.list({
      from: from === undefined ? undefined : new Date(from),
      to: to === undefined ? undefined : new Date(to),
      operation,
      actorKind,
      actorId,
      cursor,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    return {
      items: page.map(toAuditRow),
      nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
    };
  },
});
