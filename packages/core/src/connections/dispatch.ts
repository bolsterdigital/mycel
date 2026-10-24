// A committed unknown intent precedes transport. A crashed or expired lease can only reconcile,
// never authorize a blind resend. Rejected: using the job's retry count as delivery evidence.
import type { Clock, TransactionContext, UnitOfWork } from '../ports.js';
import type { IdentityStore } from '../operators/ports.js';
import type { JobOutcome } from '../jobs/ports.js';
import { systemPrincipal } from '../principal.js';
import { connectionIntentGuard, type ConnectionIntent, type ConnectionFailure } from './intents.js';

export const CONNECTION_LEASE_MS = 60_000;
export const CONNECTION_MAX_ATTEMPTS = 5;
const backoff = (attempt: number) => Math.min(3_600_000, 60_000 * 2 ** Math.min(attempt, 6));
/** Installed sources resolve a pinned mapping and current external suppression, in tenant context.
 * No source is installed by default. A source must not infer permission from a prior payload.
 * `ready` means this exact mapping, operation and consent scope are currently authorized.
 */
export interface ConnectionSource {
  prepare(
    ctx: TransactionContext,
    intent: Readonly<ConnectionIntent>
  ): Promise<
    | { ready: true; payload: Readonly<Record<string, unknown>> }
    | { ready: false; failure: ConnectionFailure }
  >;
}
export interface ConnectionTransport {
  /** `succeeded` proves the business effect, not merely an HTTP 2xx. Throws mean unknown. */
  dispatch(input: {
    tenantId: string;
    intent: Readonly<ConnectionIntent>;
    payload: Readonly<Record<string, unknown>>;
  }): Promise<'succeeded' | 'pre_send' | 'unknown'>;
  /** `absent` must prove no previous or still-running call can later perform the effect. */
  reconcile(input: {
    tenantId: string;
    intent: Readonly<ConnectionIntent>;
  }): Promise<'succeeded' | 'absent' | 'unknown'>;
}
export interface ConnectionDispatchDeps {
  uow: UnitOfWork;
  identity: Pick<IdentityStore, 'tenantAccess'>;
  clock: Clock;
  sources: Readonly<Record<string, ConnectionSource>>;
  transport: ConnectionTransport;
}

export async function runConnectionIntent(
  deps: ConnectionDispatchDeps,
  tenantId: string,
  id: string
): Promise<JobOutcome> {
  const run = async <T>(fn: (ctx: TransactionContext) => Promise<T>) => {
    // Re-load for each transaction, including the one immediately preceding transport.
    const access = await deps.identity.tenantAccess(tenantId);
    return deps.uow.run(systemPrincipal(tenantId, 'connections.run', access), fn);
  };
  const now = deps.clock.now();
  const claimed = await run(async (ctx) => {
    const row = await ctx.connectionIntents.get(id);
    if (!row || row.state === 'succeeded' || row.state === 'blocked')
      return { done: true } as const;
    if (row.leaseUntil && row.leaseUntil > now) return { next: row.leaseUntil } as const;
    if (row.nextAt > now) return { next: row.nextAt } as const;
    // An expired claim is still unknown. Only provider proof can move it back to pending.
    const reconcile = row.state === 'unknown';
    const failure = await connectionIntentGuard(ctx, row);
    if (failure) {
      const wait = failure === 'paused' || failure === 'suspended';
      await ctx.connectionIntents.replace(
        {
          ...row,
          state: reconcile ? 'unknown' : wait ? row.state : 'blocked',
          failure,
          leaseToken: null,
          leaseUntil: null,
          nextAt: new Date(now.getTime() + backoff(row.attempts)),
          updatedAt: now,
        },
        row.revision
      );
      return wait
        ? ({ next: new Date(now.getTime() + backoff(row.attempts)) } as const)
        : ({ done: true } as const);
    }
    if (row.attempts >= CONNECTION_MAX_ATTEMPTS) return { done: true } as const;
    if (!(await ctx.rateLimits.hit('connections:dispatch', { max: 60, windowSeconds: 60 }))) {
      const next = new Date(now.getTime() + 60_000);
      await ctx.connectionIntents.replace(
        { ...row, failure: 'quota', nextAt: next, updatedAt: now },
        row.revision
      );
      return { next } as const;
    }
    const token = ctx.ids.next();
    const next: ConnectionIntent = {
      ...row,
      state: 'unknown',
      failure: 'ambiguous',
      attempts: row.attempts + 1,
      leaseToken: token,
      leaseUntil: new Date(now.getTime() + CONNECTION_LEASE_MS),
      nextAt: new Date(now.getTime() + backoff(row.attempts)),
      updatedAt: now,
    };
    if (!(await ctx.connectionIntents.replace(next, row.revision)))
      return { next: new Date(now.getTime() + CONNECTION_LEASE_MS) } as const;
    await ctx.connectionIntents.record({
      id: ctx.ids.next(),
      intentId: id,
      at: now,
      kind: reconcile ? 'reconcile' : 'dispatch',
      outcome: 'started',
    });
    return { row: { ...next, revision: row.revision + 1 }, reconcile } as const;
  });
  if ('done' in claimed) return {};
  if ('next' in claimed) return { next: claimed.next };
  const { row, reconcile } = claimed;
  // A second read catches a kill-switch, revoked actor, erasure or withdrawal after claim.
  const prepared = await run(async (ctx) => {
    const current = await ctx.connectionIntents.get(id);
    if (
      !current ||
      current.leaseToken !== row.leaseToken ||
      !current.leaseUntil ||
      current.leaseUntil <= deps.clock.now()
    )
      return null;
    const failure = await connectionIntentGuard(ctx, current);
    if (failure) return { ready: false as const, failure };
    const source = Object.hasOwn(deps.sources, row.source) ? deps.sources[row.source] : undefined;
    if (!source) return { ready: false as const, failure: 'source' as const };
    const resolved = await source.prepare(ctx, current);
    if (!resolved.ready) return resolved;
    // Preparation can await a mapping/suppression lookup. Never dispatch on the earlier snapshot.
    const access = await deps.identity.tenantAccess(tenantId);
    const latest = await ctx.connectionIntents.get(id);
    if (
      !latest ||
      latest.leaseToken !== row.leaseToken ||
      !latest.leaseUntil ||
      latest.leaseUntil <= deps.clock.now()
    )
      return null;
    const lateFailure = await connectionIntentGuard(
      { ...ctx, principal: systemPrincipal(tenantId, 'connections.run', access) },
      latest
    );
    return lateFailure ? { ready: false as const, failure: lateFailure } : resolved;
  });
  if (!prepared) return { next: row.nextAt };
  let result: 'succeeded' | 'absent' | 'pre_send' | 'unknown' | 'blocked';
  let failure: ConnectionFailure | null = null;
  if (!prepared.ready) {
    result = 'blocked';
    failure = prepared.failure;
  } else {
    try {
      result = reconcile
        ? await deps.transport.reconcile({ tenantId, intent: row })
        : await deps.transport.dispatch({ tenantId, intent: row, payload: prepared.payload });
    } catch {
      // Provider text can contain both credentials and personal data; retain a closed class only.
      result = 'unknown';
    }
  }
  const finished = deps.clock.now();
  await run(async (ctx) => {
    const current = await ctx.connectionIntents.get(id);
    if (!current || current.leaseToken !== row.leaseToken) return;
    const uncertain = result === 'unknown' || (result === 'blocked' && reconcile);
    const state =
      result === 'succeeded'
        ? 'succeeded'
        : uncertain
          ? 'unknown'
          : result === 'blocked'
            ? 'blocked'
            : current.attempts >= CONNECTION_MAX_ATTEMPTS
              ? 'failed'
              : 'pending';
    if (
      !(await ctx.connectionIntents.replace(
        {
          ...current,
          state,
          failure:
            failure ??
            (state === 'failed'
              ? 'exhausted'
              : result === 'unknown'
                ? 'ambiguous'
                : result === 'pre_send'
                  ? 'pre_send'
                  : null),
          leaseToken: null,
          leaseUntil: null,
          updatedAt: finished,
        },
        current.revision
      ))
    )
      return;
    await ctx.connectionIntents.record({
      id: ctx.ids.next(),
      intentId: id,
      at: finished,
      kind: reconcile ? 'reconcile' : 'dispatch',
      outcome: result,
    });
  });
  if (result === 'succeeded' || result === 'blocked' || row.attempts >= CONNECTION_MAX_ATTEMPTS)
    return {};
  return { next: row.nextAt };
}
