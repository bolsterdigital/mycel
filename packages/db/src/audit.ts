// The audit log in Postgres (0015, TODO #17b). `auditRepository` is the tenant's log inside the
// unit of work, as mycel_app; `recordPlatformAudit` writes a platform row as mycel_platform inside
// that role's transaction (platform.ts); `deleteExpiredAudit` is the `audit.retention` job as
// mycel_audit_janitor, whose policies keep every row younger than 30 days out of its reach.

import { sql, type Kysely } from 'kysely';
import { AuditActorKind, type AuditEntry, type AuditLog } from '@mycel/core';
import type { Database } from './schema.js';

type Row = Database['audit_log'];

function toRow(e: AuditEntry): Omit<Row, 'occurred_at'> & { occurred_at: Date } {
  return {
    id: e.id,
    tenant_id: e.tenantId,
    occurred_at: e.occurredAt,
    actor_kind: e.actorKind,
    actor_id: e.actorId,
    operation: e.operation,
    effect: e.effect,
    input_hash: e.inputHash,
    result: e.result,
    request_id: e.requestId,
    subject_id: e.subjectId,
  };
}

export function auditRepository(trx: Kysely<Database>, tenantId: string): AuditLog {
  return {
    async record(entry) {
      if (entry.tenantId !== tenantId) throw new Error('audit row tenant differs from the context');
      await trx.insertInto('audit_log').values(toRow(entry)).execute();
    },
    async list({ from, to, operation, actorKind, actorId, failed, cursor, limit }) {
      let q = trx.selectFrom('audit_log').selectAll().where('tenant_id', '=', tenantId);
      if (from) q = q.where('occurred_at', '>=', from);
      if (to) q = q.where('occurred_at', '<', to);
      if (operation) q = q.where('operation', '=', operation);
      if (actorKind) q = q.where('actor_kind', '=', actorKind);
      if (actorId) q = q.where('actor_id', '=', actorId);
      if (failed) q = q.where('result', '<>', 'ok');
      if (cursor)
        q = q.where(
          sql<boolean>`(occurred_at, id) < (select c.occurred_at, c.id from audit_log c where c.id = ${cursor})`
        );
      const rows = await q
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        occurredAt: r.occurred_at,
        actorKind: AuditActorKind.parse(r.actor_kind),
        actorId: r.actor_id,
        operation: r.operation,
        effect: r.effect,
        inputHash: r.input_hash,
        result: r.result,
        requestId: r.request_id,
        subjectId: r.subject_id,
      }));
    },
  };
}

/** One platform row, inside a transaction that has entered mycel_platform (`asPlatform`). */
export async function recordPlatformAudit(trx: Kysely<Database>, entry: AuditEntry): Promise<void> {
  if (entry.actorKind !== 'platform')
    throw new Error('a platform audit row has actor_kind platform');
  await trx.insertInto('audit_log').values(toRow(entry)).execute();
}

/**
 * Delete audit rows older than `days` across tenants, in batches, as mycel_audit_janitor; returns
 * how many. The role's policies hide everything younger than 30 days, so `days` below 30 deletes
 * no more than 30 would.
 */
export async function deleteExpiredAudit(
  operatorDb: Kysely<Database>,
  days: number
): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await operatorDb.transaction().execute(async (trx) => {
      await sql`set local role mycel_audit_janitor`.execute(trx);
      const { rows } = await sql<{ n: string }>`
        with gone as (
          delete from audit_log where id in (
            select id from audit_log
            where occurred_at < now() - make_interval(days => ${days})
            limit 1000)
          returning 1)
        select count(*) as n from gone`.execute(trx);
      return Number(rows[0]?.n ?? 0);
    });
    total += n;
    if (n === 0) return total;
  }
}
