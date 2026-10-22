// The two checks of ADR 015 rule 3, over the Principal, so a use case enforces its entitlement
// once and in core (never in a front). Both refuse with `limit_exceeded`, which every front
// renders as "upgrade or contact your host" without naming a price. Suspension is not here: it is
// a property of the tenant, enforced once for every command in `Invoker.run` (`guardSuspended`).

import { UseCaseError } from '../errors.js';
import type { TransactionContext } from '../ports.js';
import type { Principal } from '../principal.js';
import type { FeatureName, LimitName } from './model.js';

export function entitled(principal: Principal, feature: FeatureName): boolean {
  const e = principal.entitlements;
  if (feature.startsWith('blocks.')) return e.blocks[feature.slice('blocks.'.length)] !== false;
  return e[feature as Exclude<FeatureName, `blocks.${string}`>];
}

export function requireEntitled(principal: Principal, feature: FeatureName): void {
  if (!entitled(principal, feature))
    throw new UseCaseError('limit_exceeded', `this site is not entitled to ${feature}`, [
      { path: '', message: 'entitlements.feature_off' },
    ]);
}

/** Refuses when `add` more would take `current` past the tenant's limit; at the limit is fine. */
export function withinLimit(
  ctx: Pick<TransactionContext, 'principal'>,
  limit: LimitName,
  current: number,
  add = 1
): void {
  const max = ctx.principal.entitlements[limit];
  if (current + add > max)
    throw new UseCaseError('limit_exceeded', `this site has reached ${limit} (${max})`, [
      { path: '', message: `entitlements.limit.${limit}` },
    ]);
}
