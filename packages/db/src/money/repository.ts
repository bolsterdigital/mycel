// Payments and their ledger over Postgres (0072, 0074, 0075, 0077). The application role cannot update or
// delete a ledger entry, so `appendLedger` is the only write there is; it numbers the entry after
// the last of its payment (`seq`), and `ledger` reads in that order, which is the order of
// writing. `save` writes exactly what a step of the state machine changes, and the supporter a
// settling step found; amount, currency, provider, reference, submission, campaign, subscription
// and sequence are fixed at insert. The subscription entries of `ledger_entries` are read and
// written by `subscriptions.ts`.
// Rejected: `save` as an upsert (a payment that vanished must not come back as a new row).
import { sql, type Kysely, type Selectable } from 'kysely';
import { LedgerEntry, Payment, PaymentStatus, type PaymentRepository } from '@mycel/core';
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
    submissionId: row.submission_id,
    campaignId: row.campaign_id,
    subscriptionId: row.subscription_id,
    sequence: row.sequence,
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
          submission_id: p.submissionId,
          campaign_id: p.campaignId,
          subscription_id: p.subscriptionId,
          sequence: p.sequence,
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
          supporter_id: p.supporterId,
        })
        .where('id', '=', p.id)
        .execute();
    },
    async list({ status, supporterId, subscriptionId }, offset, limit) {
      let q = rows();
      if (status) q = q.where('status', '=', status);
      if (supporterId) q = q.where('supporter_id', '=', supporterId);
      if (subscriptionId) q = q.where('subscription_id', '=', subscriptionId);
      const found = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(read);
    },
    async raised(campaignIds, currency) {
      const sums = new Map<string, { amount: number; gifts: number }>();
      if (!campaignIds.length) return sums;
      const found = await trx
        .selectFrom('payments')
        .select(['campaign_id'])
        .select((eb) => [
          eb.fn.sum<string>('amount').as('amount'),
          eb.fn.countAll<string>().as('gifts'),
        ])
        .where('campaign_id', 'in', [...campaignIds])
        .where('status', '=', 'paid')
        .where('currency', '=', currency)
        .groupBy('campaign_id')
        .execute();
      // `sum` and `count` come back as text (bigint); a site's total stays far below 2^53.
      for (const row of found)
        if (row.campaign_id)
          sums.set(row.campaign_id, { amount: Number(row.amount), gifts: Number(row.gifts) });
      return sums;
    },
    async due(before, limit) {
      const found = await rows()
        .where('status', 'in', ['created', 'open'])
        .where('updated_at', '<', new Date(before))
        .orderBy('updated_at')
        .orderBy('id')
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
          // The caller holds the payment's lock (or inserted it in this transaction), so the
          // next place is free; the unique key refuses a second writer that did not.
          seq: sql<number>`(select coalesce(max(seq), 0) + 1 from ledger_entries
                            where tenant_id = ${tenantId} and payment_id = ${e.paymentId})`,
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
        .orderBy('seq')
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
    // `movements` of core `money/summary.ts`: only payment entries move money, so a subscription
    // step (whose `to_status` is never one of these) stays out even without the `payment_id` test.
    async movements(from, until) {
      const found = await trx
        .selectFrom('ledger_entries')
        .select(['to_status', 'amount', 'currency', 'at'])
        .where('payment_id', 'is not', null)
        .where('to_status', 'in', ['paid', 'refunded', 'charged_back'])
        .where('at', '>=', from)
        .where('at', '<=', until)
        .orderBy('at')
        .orderBy('id')
        .execute();
      return found.map((row) => ({
        to: PaymentStatus.parse(row.to_status),
        amount: row.amount,
        currency: row.currency,
        at: toIso(row.at),
      }));
    },
  };
}
