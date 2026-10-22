// Transactional outbox (ADR 008: no broker before Postgres provably cannot do it). `publish`
// writes the event in the use case's own transaction, so an event exists if and only if the
// change that caused it committed. `drainOutbox` delivers committed events to in-process
// subscribers, claiming rows with SKIP LOCKED so several workers can run side by side.
//
// Rejected: LISTEN/NOTIFY as the transport (lost when no listener is connected) and pg-boss
// (a dependency for ~100 lines of SQL we would still need to understand).

import { sql, type Kysely } from 'kysely';
import type { DomainEvent, EventBus, Subscriber } from '@mycel/core';
import type { Database } from './schema.js';

export function outboxEventBus(trx: Kysely<Database>): EventBus {
  return {
    async publish(event) {
      await trx
        .insertInto('outbox')
        .values({
          id: event.id,
          tenant_id: event.tenantId,
          type: event.type,
          occurred_at: event.occurredAt,
          actor: JSON.stringify(event.actor),
          props: JSON.stringify(event.props),
        })
        .execute();
    },
  };
}

const MAX_ATTEMPTS = 10;
const backoffSeconds = (attempts: number) => Math.min(2 ** attempts, 3600);

interface OutboxRow {
  id: string;
  tenant_id: string;
  type: string;
  occurred_at: Date;
  actor: DomainEvent['actor'];
  props: Record<string, unknown>;
  attempts: number;
  delivered_to: string[];
}

const toEvent = (row: OutboxRow): DomainEvent => ({
  id: row.id,
  type: row.type,
  tenantId: row.tenant_id,
  occurredAt: new Date(row.occurred_at),
  actor: row.actor,
  props: row.props,
});

export interface DrainResult {
  claimed: number;
  completed: number;
  failed: number;
}

/**
 * Claim up to `batchSize` due events and deliver each to the subscribers that want it and have
 * not handled it yet. `operatorDb` connects as the operator role; the drain switches to
 * `mycel_worker` (migration 0003), the only role allowed to read the outbox across tenants.
 */
export async function drainOutbox(
  operatorDb: Kysely<Database>,
  subscribers: readonly Subscriber[],
  {
    batchSize = 50,
    onError,
  }: {
    batchSize?: number;
    onError?: (e: unknown, eventId: string, subscriber: string) => void;
  } = {}
): Promise<DrainResult> {
  return operatorDb.transaction().execute(async (trx) => {
    await sql`set local role mycel_worker`.execute(trx);
    const { rows } = await sql<OutboxRow>`
      select id, tenant_id, type, occurred_at, actor, props, attempts, delivered_to
      from outbox
      where processed_at is null and available_at <= now() and attempts < ${MAX_ATTEMPTS}
      order by id
      limit ${batchSize}
      for update skip locked`.execute(trx);

    const result: DrainResult = { claimed: rows.length, completed: 0, failed: 0 };
    for (const row of rows) {
      const event = toEvent(row);
      const delivered = new Set(row.delivered_to);
      let error: string | null = null;
      for (const sub of subscribers) {
        if (!sub.types.includes(row.type) || delivered.has(sub.name)) continue;
        try {
          await sub.handle(event);
          delivered.add(sub.name);
        } catch (e) {
          error = `${sub.name}: ${e instanceof Error ? e.message : String(e)}`;
          onError?.(e, row.id, sub.name);
        }
      }
      const done = error === null;
      await trx
        .updateTable('outbox')
        .set({
          delivered_to: [...delivered],
          processed_at: done ? new Date() : null,
          attempts: done ? row.attempts : row.attempts + 1,
          last_error: error,
          available_at: done
            ? sql<Date>`available_at`
            : sql<Date>`now() + make_interval(secs => ${backoffSeconds(row.attempts + 1)})`,
        })
        .where('id', '=', row.id)
        .execute();
      if (done) result.completed += 1;
      else result.failed += 1;
    }
    return result;
  });
}

/**
 * One outbox event by id, read as mycel_worker: the `mail.reconcile` job rebuilds its message
 * from it (brief #22C). The outbox is the cross-tenant log ADR 011 rule 1 allows, and this is its
 * second reader; the caller checks `tenantId` against the job's tenant before using it.
 */
export async function readOutboxEvent(
  operatorDb: Kysely<Database>,
  id: string
): Promise<DomainEvent | null> {
  return operatorDb.transaction().execute(async (trx) => {
    await sql`set local role mycel_worker`.execute(trx);
    const { rows } = await sql<OutboxRow>`
      select id, tenant_id, type, occurred_at, actor, props, attempts, delivered_to
      from outbox where id = ${id}`.execute(trx);
    const row = rows[0];
    return row ? toEvent(row) : null;
  });
}

/** Poll the outbox until stopped. Returns a function that stops the loop and awaits the last run. */
export function startOutboxWorker(
  operatorDb: Kysely<Database>,
  subscribers: readonly Subscriber[],
  { intervalMs = 1000, log = console }: { intervalMs?: number; log?: Pick<Console, 'error'> } = {}
): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = drainOutbox(operatorDb, subscribers, {
      onError: (e, id, sub) => log.error(`outbox ${id} -> ${sub} failed:`, e),
    })
      .then((r) => {
        // Drain again immediately while there is a backlog.
        if (!stopped) timer = setTimeout(tick, r.claimed > 0 ? 0 : intervalMs);
      })
      .catch((e) => {
        log.error('outbox drain failed:', e);
        if (!stopped) timer = setTimeout(tick, intervalMs);
      });
  };
  tick();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
