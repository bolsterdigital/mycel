// Tenant job handlers (TODO #15): pure functions over a `TransactionContext`, run by the worker
// inside a tenant-scoped unit of work under a `system` principal (ADR 011 rule 3). Platform jobs
// (partitions, the rate-limit sweep) are not here: they are SQL under their own role and live
// in packages/db.
//
// `reverifyHostname` is the withdrawal policy of brief #15 decision 8. A custom hostname is
// checked every day; three misses in a row (72 hours without the TXT record) withdraw its
// verification and, if it was primary, make the platform hostname primary again (ADR 014 rule
// 2). DNS that does not answer at all counts as nothing. Rejected: withdrawing on the first miss
// (DNS outages and TTLs give false negatives; three days is the time an admin gets to restore a
// record removed by accident) and one platform job scanning every tenant's hostnames (a
// cross-tenant read of tenant data, which ADR 011 rule 1 forbids).

import type { TransactionContext } from '../ports.js';
import { REVERIFY_INTERVAL_MS, REVERIFY_MAX_FAILURES, verifyHostname } from '../tenants/service.js';
import type { JobOutcome } from './ports.js';
import type { JobPayload } from './types.js';

/**
 * A run of the same job shortly after a recorded check (a worker that crashed between the
 * handler's commit and marking the job done) does not count a second miss.
 */
export const REVERIFY_MIN_GAP_MS = 60 * 60 * 1000;

export async function reverifyHostname(
  ctx: TransactionContext,
  { hostname }: JobPayload<'hostnames.reverify'>
): Promise<JobOutcome> {
  const row = await ctx.hostnames.get(hostname);
  // Removed since it was planned: nothing to check, nothing to plan.
  if (!row || row.kind !== 'custom') return {};
  const now = ctx.clock.now();
  const last = row.lastCheckedAt?.getTime();
  if (last !== undefined && now.getTime() - last < REVERIFY_MIN_GAP_MS)
    return { next: new Date(last + REVERIFY_INTERVAL_MS) };
  const next = new Date(now.getTime() + REVERIFY_INTERVAL_MS);

  const result = await verifyHostname(ctx, row);
  if (!result.checked || result.verified) return { next };

  const failures = row.checkFailures + 1;
  await ctx.hostnames.recordCheck(hostname, now, failures);
  if (failures >= REVERIFY_MAX_FAILURES && row.verifiedAt) {
    await ctx.hostnames.setVerified(hostname, null);
    if (row.primary) {
      const platform = (await ctx.hostnames.list()).find((h) => h.kind === 'platform');
      if (platform) await ctx.hostnames.setPrimary(platform.hostname);
    }
  }
  // Planned again whether verified or not: a withdrawn hostname comes back once its record does.
  return { next };
}
