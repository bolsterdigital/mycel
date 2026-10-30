// The two checks of ADR 015 rule 3, over the Principal, so a use case enforces its entitlement
// once and in core (never in a front). Both refuse with `limit_exceeded`, which every front
// renders as "upgrade or contact your host" without naming a price. Suspension is a property of
// the tenant, enforced once for every command in `Invoker.run` (`guardSuspended`); `requireActive`
// is that same answer for work that runs outside the Invoker.

import { UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import type { Principal } from '../principal.js';
import type { FeatureName, LimitName } from './model.js';

export function entitled(principal: Principal, feature: FeatureName): boolean {
  const e = principal.entitlements;
  if (feature.startsWith('blocks.')) return e.blocks[feature.slice('blocks.'.length)] !== false;
  return e[feature as Exclude<FeatureName, `blocks.${string}`>];
}

/**
 * `issue` replaces the generic key where a module has its own wording for the editor (assist
 * says "assistance is not available" rather than naming the entitlement); the check is the same.
 */
export function requireEntitled(
  principal: Principal,
  feature: FeatureName,
  issue = 'entitlements.feature_off'
): void {
  if (!entitled(principal, feature))
    throw new UseCaseError('limit_exceeded', `this site is not entitled to ${feature}`, [
      { path: '', message: issue },
    ]);
}

/** Refuses when `add` more would take `current` past the tenant's limit; at the limit is fine. */
export function withinLimit(
  ctx: Pick<TransactionContext, 'principal'>,
  limit: LimitName,
  current: number,
  add = 1,
  issue = `entitlements.limit.${limit}`
): void {
  const max = ctx.principal.entitlements[limit];
  if (current + add > max)
    throw new UseCaseError('limit_exceeded', `this site has reached ${limit} (${max})`, [
      { path: '', message: issue },
    ]);
}

/**
 * For work that runs outside `Invoker.run` (a scheduled publication, TODO #8a): the same answer
 * `guardSuspended` gives a command. A job handler calls it before it changes anything visible
 * and, on `suspended`, returns `{ next }` to try again later without losing its payload (the
 * pinned revision), rather than letting the throw consume an attempt (ADR 015 rule 7).
 */
export function requireActive(principal: Principal): void {
  if (!active(principal))
    throw new UseCaseError('suspended', 'this site is suspended; only reading and export work');
}

/** The test behind `requireActive`, for a handler that answers a suspension without a throw. */
export function active(principal: Principal): boolean {
  return principal.tenantStatus !== 'suspended';
}
