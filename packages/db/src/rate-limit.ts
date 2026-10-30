// Kysely implementation of the rate limiter port: fixed windows in `rate_limits`, under the
// tenant's RLS context.

import { sql, type Kysely } from 'kysely';
import { checkCooldown, type Clock, type RateLimiter } from '@mycel/core';
import type { Database } from './infra/schema.js';
import { advisoryLock } from './infra/roles.js';

type Trx = Kysely<Database>;

export function rateLimiter(trx: Trx, tenantId: string, clock: Clock): RateLimiter {
  return {
    async hit(key, { max, windowSeconds }) {
      const windowMs = windowSeconds * 1000;
      const windowStart = new Date(Math.floor(clock.now().getTime() / windowMs) * windowMs);
      const row = await trx
        .insertInto('rate_limits')
        .values({ tenant_id: tenantId, key, window_start: windowStart, hits: 1 })
        .onConflict((oc) =>
          oc
            .columns(['tenant_id', 'key', 'window_start'])
            .doUpdateSet({ hits: sql`rate_limits.hits + 1` })
        )
        .returning('hits')
        .executeTakeFirstOrThrow();
      return row.hits <= max;
    },
    async cooldown(key, seconds) {
      // The hourly sweep keeps a day of windows (janitor.ts); a longer wait would be forgotten.
      checkCooldown(seconds);
      // Same table, its own key and a sliding window: the latest row says when the last success
      // was. The advisory lock serialises two attempts on one key, so exactly one sees no row;
      // rejected: the fixed window of `hit` with max 1 (two mails at 23:59 and 00:01 UTC).
      await advisoryLock(trx, 'rate', tenantId, key);
      const now = clock.now();
      const recent = await trx
        .selectFrom('rate_limits')
        .select('hits')
        .where('tenant_id', '=', tenantId)
        .where('key', '=', key)
        .where('window_start', '>', new Date(now.getTime() - seconds * 1000))
        .executeTakeFirst();
      if (recent) return false;
      await trx
        .insertInto('rate_limits')
        .values({ tenant_id: tenantId, key, window_start: now, hits: 1 })
        .onConflict((oc) => oc.columns(['tenant_id', 'key', 'window_start']).doNothing())
        .execute();
      return true;
    },
  };
}
