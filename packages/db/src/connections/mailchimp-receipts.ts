// Tenant-scoped durable pre-effect evidence; only the observation fields can be updated.
// Rejected: an upsert which replaces the baseline after a provider timeout.
import { sql, type Kysely, type Selectable } from 'kysely';
import type { MailchimpReceipt, MailchimpReceipts } from '@mycel/core';
import type { Database } from '../infra/schema.js';
const decode = (r: Selectable<Database['mailchimp_receipts']>): MailchimpReceipt => ({
  intentId: r.intent_id,
  connectionId: r.connection_id,
  supporterId: r.supporter_id,
  memberHash: r.member_hash,
  baselineStatus: r.baseline_status,
  baselineChangedAt: r.baseline_changed_at ? new Date(r.baseline_changed_at) : null,
  requestedAt: new Date(r.requested_at),
  status: r.status,
  observedAt: new Date(r.observed_at),
  retryable: r.retryable,
  confirmedAt: r.confirmed_at ? new Date(r.confirmed_at) : null,
});
export function mailchimpReceipts(trx: Kysely<Database>, tenantId: string): MailchimpReceipts {
  return {
    async forMember(connectionId, hash) {
      const row = await trx
        .selectFrom('mailchimp_receipts')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('connection_id', '=', connectionId)
        .where('member_hash', '=', hash)
        .orderBy('requested_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      return row ? decode(row) : null;
    },
    async get(id) {
      const row = await trx
        .selectFrom('mailchimp_receipts')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('intent_id', '=', id)
        .executeTakeFirst();
      return row ? decode(row) : null;
    },
    async insert(r) {
      const row = await trx
        .insertInto('mailchimp_receipts')
        .values({
          tenant_id: tenantId,
          intent_id: r.intentId,
          connection_id: r.connectionId,
          supporter_id: r.supporterId,
          member_hash: r.memberHash,
          baseline_status: r.baselineStatus,
          baseline_changed_at: r.baselineChangedAt,
          requested_at: r.requestedAt,
          status: r.status,
          observed_at: r.observedAt,
          confirmed_at: r.confirmedAt,
          retryable: r.retryable,
        })
        .onConflict((c) => c.column('intent_id').doNothing())
        .returning('intent_id')
        .executeTakeFirst();
      return !!row;
    },
    async retryable(id, value) {
      await trx
        .updateTable('mailchimp_receipts')
        .set({ retryable: value })
        .where('tenant_id', '=', tenantId)
        .where('intent_id', '=', id)
        .execute();
    },
    async observe(id, status, at, confirmedAt) {
      await trx
        .updateTable('mailchimp_receipts')
        .set({ status, observed_at: at, confirmed_at: sql`coalesce(confirmed_at, ${confirmedAt})` })
        .where('tenant_id', '=', tenantId)
        .where('intent_id', '=', id)
        .execute();
    },
  };
}
