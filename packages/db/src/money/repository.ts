// Payments and their ledger over Postgres (0072). The application role cannot update or delete a
// ledger entry, so `appendLedger` is the only write there is. `save` writes exactly what a step
// of the state machine changes; amount, currency, provider and reference are fixed at insert.
// Rejected: `save` as an upsert (a payment that vanished must not come back as a new row).
import type { Kysely, Selectable } from 'kysely';
import { LedgerEntry, Payment, type PaymentRepository } from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { toIso } from '../infra/dates.js';

const read = (row: Selectable<Database['payments']>): Payment =>
  Payment.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    description: row.description,
    locale: row.locale,
    provider: row.provider,
    providerRef: row.provider_ref,
    providerStatus: row.provider_status,
    checkoutUrl: row.checkout_url,
    supporterId: row.supporter_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    paidAt: toIso(row.paid_at),
  });

export function paymentRepository(trx: Kysely<Database>, tenantId: string): PaymentRepository {
  const rows = () => trx.selectFrom('payments').selectAll();
  const one = async (q: ReturnType<typeof rows>) => {
    const row = await q.executeTakeFirst();
    return row ? read(row) : null;
  };
  return {
    async insert(p) {
      await trx
        .insertInto('payments')
        .values({
          id: p.id,
          tenant_id: tenantId,
          kind: p.kind,
          status: p.status,
          amount: p.amount,
          currency: p.currency,
          description: p.description,
          locale: p.locale,
          provider: p.provider,
          provider_ref: p.providerRef,
          provider_status: p.providerStatus,
          checkout_url: p.checkoutUrl,
          supporter_id: p.supporterId,
          created_at: p.createdAt,
          updated_at: p.updatedAt,
          paid_at: p.paidAt,
        })
        .execute();
    },
    get: (id) => one(rows().where('id', '=', id)),
    lock: (id) => one(rows().where('id', '=', id).forUpdate()),
    async save(p) {
      await trx
        .updateTable('payments')
        .set({
          status: p.status,
          provider_status: p.providerStatus,
          checkout_url: p.checkoutUrl,
          updated_at: p.updatedAt,
          paid_at: p.paidAt,
        })
        .where('id', '=', p.id)
        .execute();
    },
    async list({ status, supporterId }, offset, limit) {
      let q = rows();
      if (status) q = q.where('status', '=', status);
      if (supporterId) q = q.where('supporter_id', '=', supporterId);
      const found = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(read);
    },
    async appendLedger(e) {
      await trx
        .insertInto('ledger_entries')
        .values({
          id: e.id,
          tenant_id: tenantId,
          payment_id: e.paymentId,
          from_status: e.from,
          to_status: e.to,
          cause: e.cause,
          provider_status: e.providerStatus,
          amount: e.amount,
          currency: e.currency,
          at: e.at,
          actor: JSON.stringify(e.actor),
        })
        .execute();
    },
    async ledger(paymentId) {
      const found = await trx
        .selectFrom('ledger_entries')
        .selectAll()
        .where('payment_id', '=', paymentId)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return found.map((row) =>
        LedgerEntry.parse({
          id: row.id,
          paymentId: row.payment_id,
          from: row.from_status,
          to: row.to_status,
          cause: row.cause,
          providerStatus: row.provider_status,
          amount: row.amount,
          currency: row.currency,
          at: toIso(row.at),
          actor: row.actor,
        })
      );
    },
  };
}
