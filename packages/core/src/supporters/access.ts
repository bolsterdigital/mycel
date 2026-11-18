// Comped and gifted access as supporter events (ADR 016 rule 2). A grant and its withdrawal are
// two appended facts, `access.granted` and `access.revoked`; the projection keeps the standing
// grant per tier (model.ts) and `hasAccess` reads the clock, so nothing here expires anything.
//
// Both commands ask for `tenant:admin`: giving someone a paid tier without a payment is a
// decision about the site's money and readers, not editing. MCP and HTTP get the same gate from
// the registry. Rejected: `supporters:write` (an import key would then hand out access) and a new
// capability (a stored set, a form and two catalogs for a grant nobody delegates yet).

import { z } from 'zod';
import { notFound, UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import { defineUseCase } from '../registry.js';
import { sha1Hex } from '../util/digest.js';
import { exampleId } from '../util/ids.js';
import '../content/ports.js';
import { isTombstone } from './erasure.js';
import { SupporterEvent } from './events.js';
import { SupporterProjection } from './model.js';
import { SOURCE, appendAndFold } from './service.js';
import './ports.js';

const Reason = z.string().trim().min(1).max(500);

/** What an operator may give by hand: a `paid` grant only comes from a paid membership period. */
const ManualGrantKind = z.enum(['comp', 'gift']);

/**
 * The live supporter under its address lock (ADR 019 rule 3), read again after the lock so the
 * append folds onto what is current. An erased supporter gets no grant: there is nobody to read.
 */
async function lockedSupporter(
  ctx: TransactionContext,
  supporterId: string
): Promise<SupporterProjection> {
  const before = await ctx.supporters.getProjectionById(supporterId);
  if (!before) throw notFound('supporter');
  await ctx.supporters.lock(before.email);
  const current = await ctx.supporters.getProjectionById(supporterId);
  if (!current || current.email !== before.email)
    throw new UseCaseError('conflict', 'the supporter changed while the request ran; retry');
  if (isTombstone(current.email) || !(await ctx.erasures.allows(current.email, supporterId)))
    throw new UseCaseError('conflict', 'an erased supporter cannot hold access');
  return current;
}

async function appendAccessEvent(
  ctx: TransactionContext,
  supporter: SupporterProjection,
  type: 'access.granted' | 'access.revoked',
  tierId: string,
  props: Record<string, unknown>
): Promise<SupporterProjection> {
  const occurredAt = ctx.clock.now().toISOString();
  // The tier is in the reference, so two tiers granted in one millisecond are two events.
  const sourceRef = `supporter:${supporter.id}:tier:${tierId}`;
  const appended = await appendAndFold(ctx, {
    ...SupporterEvent.parse({
      schema: 'wings.supporter-event.v1',
      id: await sha1Hex([SOURCE, sourceRef, type, occurredAt].join('|')),
      type,
      email: supporter.email,
      occurred_at: occurredAt,
      source: SOURCE,
      source_site: 'urn:mycel:supporters',
      source_ref: sourceRef,
      props: { tier_id: tierId, ...props },
    }),
    supporter_id: supporter.id,
  });
  if (!appended) throw new UseCaseError('conflict', 'a change was just recorded; retry');
  const after = await ctx.supporters.getProjectionById(supporter.id);
  if (!after) throw new Error(`supporter ${supporter.id} vanished during an access change`);
  return after;
}

export const createAccessGrant = defineUseCase({
  name: 'supporter.access_grant.create',
  kind: 'command',
  description:
    'Give a supporter access to a tier without a payment, as a comp or a gift, optionally until a moment (exclusive). A new grant for the same tier replaces the standing one. The reason stays in the event log and is never shown publicly.',
  requires: 'tenant:admin',
  consumes: null,
  input: z.object({
    supporterId: z.string().guid(),
    tierId: z.string().guid(),
    kind: ManualGrantKind,
    reason: Reason,
    until: z.string().datetime({ offset: true }).optional(),
  }),
  output: SupporterProjection,
  examples: [
    {
      input: {
        supporterId: exampleId(0x1),
        tierId: exampleId(0x2),
        kind: 'comp',
        reason: 'Press access for the election week.',
        until: '2027-01-01T00:00:00.000Z',
      },
    },
  ],
  async handler(ctx, { supporterId, tierId, kind, reason, until }) {
    // The tier is read under the tenant's context: another tenant's tier does not exist here.
    if (!(await ctx.accessTiers.get(tierId))) throw notFound('access tier');
    if (until !== undefined && Date.parse(until) <= ctx.clock.now().getTime())
      throw new UseCaseError('invalid_input', 'until lies in the past', [
        { path: 'until', message: 'supporter.access.until-past' },
      ]);
    const supporter = await lockedSupporter(ctx, supporterId);
    return appendAccessEvent(ctx, supporter, 'access.granted', tierId, {
      kind,
      reason,
      ...(until === undefined ? {} : { until: new Date(until).toISOString() }),
    });
  },
});

export const revokeAccessGrant = defineUseCase({
  name: 'supporter.access_grant.revoke',
  kind: 'command',
  description:
    'Take back the standing grant a supporter holds for a tier, from now on. The withdrawal is an event of its own; the grant stays in the log.',
  requires: 'tenant:admin',
  input: z.object({
    supporterId: z.string().guid(),
    tierId: z.string().guid(),
    reason: Reason,
  }),
  output: SupporterProjection,
  examples: [
    {
      input: {
        supporterId: exampleId(0x1),
        tierId: exampleId(0x2),
        reason: 'The press week is over.',
      },
    },
  ],
  async handler(ctx, { supporterId, tierId, reason }) {
    const supporter = await lockedSupporter(ctx, supporterId);
    if (!supporter.grants.some((g) => g.tierId === tierId)) throw notFound('access grant');
    return appendAccessEvent(ctx, supporter, 'access.revoked', tierId, { reason });
  },
});
