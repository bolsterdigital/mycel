// Supporter admissions over Postgres (0010; ADR 015 rule 3 with ADR 019 rule 3, TODO #16): the
// seats `forms.submit` reserves for addresses whose projection the outbox ingest has not written
// yet. Runs in the use case's own transaction as mycel_app, so a refused submission rolls its
// reservation back with everything else. `lock` is a transaction-scoped advisory lock per tenant,
// the pattern of `members.lock()`; `count` is one statement, so supporters and reservations come
// from one snapshot. The window comes from the injected clock, so a test can age a reservation.
// Rejected: `select ... for update` on the reservations (a first admission has no row to lock).

import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  ADMISSION_WINDOW_MS,
  normalizeEmail,
  type Clock,
  type SupporterAdmissions,
} from '@mycel/core';
import type { Database } from './schema.js';

type Trx = Kysely<Database>;

export function supporterAdmissions(trx: Trx, tenantId: string, clock: Clock): SupporterAdmissions {
  // Like the rate-limit key in forms.submit: the table never holds the address itself.
  const hash = (email: string) =>
    createHash('sha256')
      .update(`${tenantId}:${normalizeEmail(email)}`)
      .digest('hex');
  const cutoff = () => new Date(clock.now().getTime() - ADMISSION_WINDOW_MS);
  return {
    async lock() {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`admissions:${tenantId}`}, 0))`.execute(
        trx
      );
    },
    async count() {
      const { rows } = await sql<{ n: string }>`
        select (select count(*) from supporters where tenant_id = ${tenantId})
             + (select count(*) from supporter_admissions
                where tenant_id = ${tenantId} and admitted_at > ${cutoff()}) as n`.execute(trx);
      return Number(rows[0]?.n ?? 0);
    },
    async pending(email) {
      const row = await trx
        .selectFrom('supporter_admissions')
        .select('email_hash')
        .where('tenant_id', '=', tenantId)
        .where('email_hash', '=', hash(email))
        .where('admitted_at', '>', cutoff())
        .executeTakeFirst();
      return row !== undefined;
    },
    async reserve(email) {
      await trx
        .deleteFrom('supporter_admissions')
        .where('tenant_id', '=', tenantId)
        .where('admitted_at', '<=', cutoff())
        .execute();
      await trx
        .insertInto('supporter_admissions')
        .values({ tenant_id: tenantId, email_hash: hash(email), admitted_at: clock.now() })
        .onConflict((oc) => oc.columns(['tenant_id', 'email_hash']).doNothing())
        .execute();
    },
    async release(email) {
      await trx
        .deleteFrom('supporter_admissions')
        .where('tenant_id', '=', tenantId)
        .where('email_hash', '=', hash(email))
        .execute();
    },
  };
}
