// Durable connector work keeps uncertainty separate from retryability (ADR 019/024).
// Rejected: retrying a thrown transport call, which may already have changed the provider.
import { z } from 'zod';
import type { TransactionContext } from '../ports.js';
import { UseCaseError } from '../errors.js';
import { defineUseCase } from '../registry.js';
import { can, grants } from '../principal.js';
import { sha256Hex } from '../util/digest.js';
import { PROVIDER_RECONCILES, type ConnectionProvider } from './ports.js';
import { isSyntheticIntent, SYNTHETIC_SCOPE, SYNTHETIC_SOURCE } from './synthetic.js';

export const ConnectionIntentState = z.enum([
  'pending',
  'unknown',
  'succeeded',
  'blocked',
  'failed',
  // An operator confirmed by hand what happened to an `unknown` intent the transport cannot
  // reconcile. Terminal; the confirmation is the command's audit row.
  'resolved',
]);
export type ConnectionIntentState = z.infer<typeof ConnectionIntentState>;
export const ConnectionFailure = z.enum([
  'paused',
  'disconnected',
  'version',
  'credential',
  'authorization',
  'consent',
  'erasure',
  'suspended',
  'source',
  'quota',
  'pre_send',
  'ambiguous',
  'exhausted',
]);
export type ConnectionFailure = z.infer<typeof ConnectionFailure>;
export const CONNECTION_MAX_ATTEMPTS = 5;
export interface ConnectionIntent {
  id: string;
  connectionId: string;
  businessId: string;
  connectionVersion: number;
  credentialVersion: number;
  source: string;
  mappingVersion: string;
  supporterId: string | null;
  scope: string;
  actor: { kind: 'operator' | 'api-key'; id: string } | { kind: 'system'; id: string };
  key: string;
  state: ConnectionIntentState;
  failure: ConnectionFailure | null;
  attempts: number;
  revision: number;
  leaseToken: string | null;
  leaseUntil: Date | null;
  nextAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
export interface ConnectionAttempt {
  id: string;
  intentId: string;
  at: Date;
  kind: 'dispatch' | 'reconcile';
  outcome: 'started' | 'succeeded' | 'absent' | 'unknown' | 'pre_send' | 'blocked';
}
export interface ConnectionIntents {
  get(id: string): Promise<ConnectionIntent | null>;
  list(connectionId: string, limit: number): Promise<ConnectionIntent[]>;
  byBusiness(connectionId: string, businessId: string): Promise<ConnectionIntent | null>;
  insert(row: ConnectionIntent): Promise<boolean>;
  /** Atomically replace only the revision read; every successful replacement increments it. */
  replace(row: ConnectionIntent, expectedRevision: number): Promise<boolean>;
  record(attempt: ConnectionAttempt): Promise<void>;
  attempts(id: string): Promise<ConnectionAttempt[]>;
  /** Register, not just the asynchronously scrubbed projection. */
  erased(supporterId: string): Promise<boolean>;
}
declare module '../ports.js' {
  interface TransactionContext {
    connectionIntents: ConnectionIntents;
  }
}
export type ConnectionIntentRequest = Pick<
  ConnectionIntent,
  | 'connectionId'
  | 'businessId'
  | 'connectionVersion'
  | 'source'
  | 'mappingVersion'
  | 'supporterId'
  | 'scope'
>;
const requestSchema = z
  .object({
    connectionId: z.string().guid(),
    businessId: z.string().guid(),
    connectionVersion: z.number().int().positive(),
    source: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
    mappingVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
    supporterId: z.string().guid(),
    scope: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,63}$/),
  })
  .strict();

/** Current generic guards; an installed source additionally proves its mapping. */
export async function connectionIntentGuard(
  ctx: TransactionContext,
  row: ConnectionIntent
): Promise<ConnectionFailure | null> {
  if (ctx.principal.tenantStatus !== 'active') return 'suspended';
  const c = await ctx.connections.get(row.connectionId);
  if (!c || c.state === 'disconnected') return 'disconnected';
  if (c.state === 'paused') return 'paused';
  const synthetic = isSyntheticIntent(row);
  if (c.version !== row.connectionVersion || (!synthetic && !c.consentScopes.includes(row.scope)))
    return 'version';
  if (!c.hasCredential || c.credentialVersion !== row.credentialVersion) return 'credential';
  if (row.actor.kind === 'operator') {
    const m = await ctx.members.get(row.actor.id);
    if (!m || !grants(m.capabilities, 'connections:configure')) return 'authorization';
  } else if (row.actor.kind === 'api-key') {
    const k = (await ctx.apiKeys.list()).find((k) => k.id === row.actor.id);
    if (!k || k.revokedAt || !grants(k.capabilities, 'connections:configure'))
      return 'authorization';
  }
  if (synthetic) return null;
  if (!row.supporterId || (await ctx.connectionIntents.erased(row.supporterId))) return 'erasure';
  const supporter = await ctx.supporters.getProjectionById(row.supporterId);
  if (!supporter || supporter.email.endsWith('@erased.invalid')) return 'erasure';
  if (!supporter.lists.includes(row.scope)) return 'consent';
  return null;
}

/** Internal transaction boundary for the future action subscriber, not a provisional feed route. */
export async function planConnectionIntent(
  ctx: TransactionContext,
  raw: ConnectionIntentRequest
): Promise<ConnectionIntent> {
  const input = requestSchema.parse(raw);
  if (!can(ctx.principal, 'connections:configure') || ctx.principal.actor.kind === 'anonymous')
    throw new UseCaseError('forbidden', 'connection planning is not authorized');
  const old = await ctx.connectionIntents.byBusiness(input.connectionId, input.businessId);
  if (old) {
    if (Object.entries(input).some(([k, v]) => old[k as keyof ConnectionIntent] !== v))
      throw new UseCaseError('conflict', 'business intent already has another contract');
    return old;
  }
  const c = await ctx.connections.get(input.connectionId);
  if (!c) throw new UseCaseError('not_found', 'connection not found');
  const actor = ctx.principal.actor;
  const now = ctx.clock.now();
  const row: ConnectionIntent = {
    ...input,
    id: ctx.ids.next(),
    credentialVersion: c.credentialVersion,
    actor:
      actor.kind === 'operator'
        ? { kind: 'operator', id: actor.operatorId }
        : actor.kind === 'system'
          ? { kind: 'system', id: actor.job }
          : { kind: 'api-key', id: actor.keyId },
    key: await sha256Hex(
      JSON.stringify([ctx.principal.tenantId, input.connectionId, input.businessId])
    ),
    state: 'pending',
    failure: null,
    attempts: 0,
    revision: 0,
    leaseToken: null,
    leaseUntil: null,
    nextAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const failure = await connectionIntentGuard(ctx, row);
  if (failure) throw new UseCaseError('conflict', `connection intent blocked: ${failure}`);
  if (!(await ctx.connectionIntents.insert(row))) return planConnectionIntent(ctx, input);
  await enqueueConnectionIntent(ctx, row.id, now);
  return row;
}
export async function enqueueConnectionIntent(
  ctx: TransactionContext,
  id: string,
  at: Date
): Promise<void> {
  await ctx.jobs.enqueue({
    type: 'connections.run',
    key: `connections.run:${ctx.principal.tenantId}:${id}`,
    runAt: at,
    payload: { intentId: id },
  });
}
const id = z.object({ id: z.string().guid() }).strict();
const example = { id: '01900000-0000-7000-8000-000000000001' };
const view = z.object({
  id: z.string().guid(),
  connectionId: z.string().guid(),
  state: ConnectionIntentState,
  failure: ConnectionFailure.nullable(),
  attempts: z.number().int().nonnegative(),
  nextAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  externalCopyAction: z.enum(['requested', 'confirmed', 'failed', 'manual']).nullable(),
  /** What an operator with `connections:replay` can do next; the fronts render only this. */
  operatorAction: z.enum(['replay', 'resolve']).nullable(),
});

/**
 * Replay only where another attempt can be safe: a pending intent, or an unknown one whose
 * transport can reconcile first. An unknown intent without that proof is resolved by hand,
 * because re-sending it could repeat an effect the receiver already performed (ADR 019/024).
 */
function operatorAction(
  r: ConnectionIntent,
  provider: ConnectionProvider
): 'replay' | 'resolve' | null {
  const reconciles = PROVIDER_RECONCILES[provider];
  if (r.state === 'unknown')
    return reconciles && r.attempts < CONNECTION_MAX_ATTEMPTS ? 'replay' : 'resolve';
  return r.state === 'pending' && r.attempts < CONNECTION_MAX_ATTEMPTS ? 'replay' : null;
}
const asView = (r: ConnectionIntent, provider: ConnectionProvider) => ({
  id: r.id,
  connectionId: r.connectionId,
  state: r.state,
  failure: r.failure,
  attempts: r.attempts,
  nextAt: r.nextAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  externalCopyAction: isSyntheticIntent(r)
    ? null
    : ((r.state === 'succeeded'
        ? 'confirmed'
        : r.state === 'unknown' || r.state === 'resolved'
          ? 'manual'
          : r.state === 'blocked' || r.state === 'failed'
            ? 'failed'
            : 'requested') as 'requested' | 'confirmed' | 'failed' | 'manual'),
  operatorAction: operatorAction(r, provider),
});
export const listConnectionIntents = defineUseCase({
  name: 'connections.intent.list',
  description: 'List redacted recent delivery status for one managed connection.',
  kind: 'query',
  requires: 'connections:read',
  authenticatedOnly: true,
  input: z.object({ connectionId: z.string().guid() }).strict(),
  output: z.object({ intents: z.array(view) }),
  examples: [{ input: { connectionId: example.id } }],
  async handler(ctx, { connectionId }) {
    const c = await ctx.connections.get(connectionId);
    if (!c) throw new UseCaseError('not_found', 'connection not found');
    return {
      intents: (await ctx.connectionIntents.list(connectionId, 30)).map((r) =>
        asView(r, c.provider)
      ),
    };
  },
});

export const testConnection = defineUseCase({
  name: 'connections.test',
  description: 'Queue a signed webhook containing synthetic data only.',
  kind: 'command',
  requires: 'connections:configure',
  authenticatedOnly: true,
  input: z.object({ id: z.string().guid() }).strict(),
  output: view,
  examples: [{ input: example }],
  async handler(ctx, { id }) {
    const c = await ctx.connections.get(id);
    if (!c) throw new UseCaseError('not_found', 'connection not found');
    if (c.provider !== 'webhook') throw new UseCaseError('invalid_input', 'not a webhook');
    const actor = ctx.principal.actor;
    if (actor.kind === 'anonymous') throw new UseCaseError('forbidden', 'authentication required');
    const at = ctx.clock.now();
    const businessId = ctx.ids.next();
    const row: ConnectionIntent = {
      id: ctx.ids.next(),
      connectionId: id,
      businessId,
      connectionVersion: c.version,
      credentialVersion: c.credentialVersion,
      source: SYNTHETIC_SOURCE,
      mappingVersion: c.contractVersion,
      supporterId: null,
      scope: SYNTHETIC_SCOPE,
      actor:
        actor.kind === 'operator'
          ? { kind: 'operator', id: actor.operatorId }
          : actor.kind === 'api-key' || actor.kind === 'agent'
            ? { kind: 'api-key', id: actor.keyId }
            : { kind: 'system', id: actor.job },
      key: await sha256Hex(JSON.stringify([ctx.principal.tenantId, id, businessId])),
      state: 'pending',
      failure: null,
      attempts: 0,
      revision: 0,
      leaseToken: null,
      leaseUntil: null,
      nextAt: at,
      createdAt: at,
      updatedAt: at,
    };
    const failure = await connectionIntentGuard(ctx, row);
    if (failure) throw new UseCaseError('conflict', `connection test blocked: ${failure}`);
    await ctx.connectionIntents.insert(row);
    await enqueueConnectionIntent(ctx, row.id, at);
    return asView(row, c.provider);
  },
});
const intentWithProvider = async (ctx: TransactionContext, id: string) => {
  const row = await ctx.connectionIntents.get(id);
  const c = row && (await ctx.connections.get(row.connectionId));
  if (!row || !c) throw new UseCaseError('not_found', 'connection intent not found');
  return { row, provider: c.provider };
};
export const getConnectionIntent = defineUseCase({
  name: 'connections.intent.get',
  description: 'Read redacted delivery status for one connection intent.',
  kind: 'query',
  requires: 'connections:read',
  authenticatedOnly: true,
  input: id,
  output: view,
  examples: [{ input: example }],
  async handler(ctx, { id }) {
    const { row, provider } = await intentWithProvider(ctx, id);
    return asView(row, provider);
  },
});
export const replayConnectionIntent = defineUseCase({
  name: 'connections.intent.replay',
  description:
    'Request a guarded retry of a pending intent, or reconciliation of an unknown one where the transport can prove the outcome.',
  kind: 'command',
  requires: 'connections:replay',
  authenticatedOnly: true,
  input: id,
  output: view,
  examples: [{ input: example }],
  async handler(ctx, { id }) {
    const { row, provider } = await intentWithProvider(ctx, id);
    const failure = await connectionIntentGuard(ctx, row);
    if (failure) throw new UseCaseError('conflict', `connection intent blocked: ${failure}`);
    if (operatorAction(row, provider) !== 'replay')
      throw new UseCaseError(
        'conflict',
        row.state === 'unknown'
          ? 'connection intent outcome is unknown and needs manual resolution'
          : 'connection intent cannot be replayed'
      );
    // Preserve lease, uncertainty and backoff. The worker rechecks the original authority too.
    await enqueueConnectionIntent(
      ctx,
      id,
      row.nextAt > ctx.clock.now() ? row.nextAt : ctx.clock.now()
    );
    return asView(row, provider);
  },
});
export const resolveConnectionIntent = defineUseCase({
  name: 'connections.intent.resolve',
  description:
    'Mark an unknown intent as handled after checking the receiver by hand; it is never sent again.',
  kind: 'command',
  requires: 'connections:replay',
  authenticatedOnly: true,
  input: id,
  output: view,
  examples: [{ input: example }],
  async handler(ctx, { id }) {
    const { row, provider } = await intentWithProvider(ctx, id);
    const now = ctx.clock.now();
    if (operatorAction(row, provider) !== 'resolve')
      throw new UseCaseError(
        'conflict',
        'only an unknown intent without reconciliation is resolved'
      );
    // A running attempt may still report; resolving under its lease would race that result.
    if (row.leaseUntil && row.leaseUntil > now)
      throw new UseCaseError('conflict', 'connection intent is being attempted');
    const next: ConnectionIntent = {
      ...row,
      state: 'resolved',
      leaseToken: null,
      leaseUntil: null,
      updatedAt: now,
    };
    if (!(await ctx.connectionIntents.replace(next, row.revision)))
      throw new UseCaseError('conflict', 'connection intent changed');
    return asView({ ...next, revision: row.revision + 1 }, provider);
  },
});
