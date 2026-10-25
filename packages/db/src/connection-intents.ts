// RLS scopes all intent operations; compare-and-swap fences concurrent and expired workers.
// Rejected: unconditional completion updates that let an old attempt overwrite a newer one.
import type { Kysely, Selectable } from 'kysely';
import type { ConnectionIntent, ConnectionIntents } from '@mycel/core';
import type { Database } from './schema.js';
function decode(r: Selectable<Database['connection_intents']>): ConnectionIntent {
  return {
    id: r.id,
    connectionId: r.connection_id,
    businessId: r.business_id,
    connectionVersion: r.connection_version,
    credentialVersion: r.credential_version,
    source: r.source,
    mappingVersion: r.mapping_version,
    supporterId: r.supporter_id,
    scope: r.scope,
    actor: r.actor,
    key: r.key,
    state: r.state,
    failure: r.failure,
    attempts: r.attempts,
    revision: r.revision,
    leaseToken: r.lease_token,
    leaseUntil: r.lease_until,
    nextAt: r.next_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
const encode = (r: ConnectionIntent) => ({
  id: r.id,
  connection_id: r.connectionId,
  business_id: r.businessId,
  connection_version: r.connectionVersion,
  credential_version: r.credentialVersion,
  source: r.source,
  mapping_version: r.mappingVersion,
  supporter_id: r.supporterId,
  scope: r.scope,
  actor: JSON.stringify(r.actor),
  key: r.key,
  state: r.state,
  failure: r.failure,
  attempts: r.attempts,
  revision: r.revision,
  lease_token: r.leaseToken,
  lease_until: r.leaseUntil,
  next_at: r.nextAt,
  created_at: r.createdAt,
  updated_at: r.updatedAt,
});
export function connectionIntentsRepository(
  trx: Kysely<Database>,
  tenantId: string
): ConnectionIntents {
  const query = () =>
    trx.selectFrom('connection_intents').selectAll().where('tenant_id', '=', tenantId);
  return {
    async get(id) {
      const r = await query().where('id', '=', id).executeTakeFirst();
      return r ? decode(r) : null;
    },
    async list(connectionId, limit) {
      return (
        await query()
          .where('connection_id', '=', connectionId)
          .orderBy('created_at', 'desc')
          .limit(limit)
          .execute()
      ).map(decode);
    },
    async byBusiness(connectionId, businessId) {
      const r = await query()
        .where('connection_id', '=', connectionId)
        .where('business_id', '=', businessId)
        .executeTakeFirst();
      return r ? decode(r) : null;
    },
    async insert(row) {
      const r = await trx
        .insertInto('connection_intents')
        .values({ ...encode(row), tenant_id: tenantId })
        .onConflict((oc) => oc.columns(['tenant_id', 'connection_id', 'business_id']).doNothing())
        .returning('id')
        .executeTakeFirst();
      return !!r;
    },
    async replace(row, expectedRevision) {
      const r = await trx
        .updateTable('connection_intents')
        .set({ ...encode(row), revision: expectedRevision + 1 })
        .where('id', '=', row.id)
        .where('tenant_id', '=', tenantId)
        .where('revision', '=', expectedRevision)
        .returning('id')
        .executeTakeFirst();
      return !!r;
    },
    async record(a) {
      await trx
        .insertInto('connection_attempts')
        .values({
          id: a.id,
          tenant_id: tenantId,
          intent_id: a.intentId,
          at: a.at,
          kind: a.kind,
          outcome: a.outcome,
        })
        .execute();
    },
    async attempts(id) {
      return (
        await trx
          .selectFrom('connection_attempts')
          .selectAll()
          .where('tenant_id', '=', tenantId)
          .where('intent_id', '=', id)
          .orderBy('at')
          .execute()
      ).map((r) => ({
        id: r.id,
        intentId: r.intent_id,
        at: r.at,
        kind: r.kind,
        outcome: r.outcome,
      }));
    },
    async erased(supporterId) {
      return !!(await trx
        .selectFrom('erasures')
        .select('supporter_id')
        .where('tenant_id', '=', tenantId)
        .where('supporter_id', '=', supporterId)
        .executeTakeFirst());
    },
  };
}
