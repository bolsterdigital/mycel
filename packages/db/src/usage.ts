// Usage of one tenant over Postgres (ADR 015 rule 6, TODO #16): counts in the use case's own
// transaction as mycel_app, so RLS scopes every count to this tenant; the explicit `tenant_id`
// filter is for the index, not for isolation. The month boundary comes from the injected clock,
// so the count and a test agree on what "this month" is.

import { sql, type Kysely } from 'kysely';
import type { Clock, UsageReader } from '@mycel/core';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

export function usageReader(trx: Trx, tenantId: string, clock: Clock): UsageReader {
  const count = async (
    table: 'supporters' | 'mail_sends' | 'tenant_hostnames' | 'tenant_memberships',
    where: (q: ReturnType<typeof base>) => ReturnType<typeof base> = (q) => q
  ) => Number((await where(base(table)).executeTakeFirstOrThrow()).n);
  const base = (table: 'supporters' | 'mail_sends' | 'tenant_hostnames' | 'tenant_memberships') =>
    trx
      .selectFrom(table)
      .select(sql<string>`count(*)`.as('n'))
      .where('tenant_id', '=', tenantId);
  return {
    supporters: () => count('supporters'),
    mailsThisMonth() {
      const now = clock.now();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return count('mail_sends', (q) => q.where(sql<boolean>`sent_at >= ${start}`));
    },
    // TODO #10: sum(size_bytes) over media
    storageBytes: async () => 0,
    customHostnames: () => count('tenant_hostnames', (q) => q.where(sql<boolean>`kind = 'custom'`)),
    operators: () => count('tenant_memberships'),
  };
}
