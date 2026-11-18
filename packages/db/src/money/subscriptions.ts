// Subscriptions, mandates, charge attempts and the subscription entries of the ledger over
// Postgres (0077). `save` writes what a step changes; kind, amount, currency, interval,
// description, provider, tier and campaign are fixed at insert. A ledger entry is numbered after
// the last one of its subscription under the subscription's lock, as a payment's are (0072).
// Rejected: `save` as an upsert (a subscription that vanished must not come back as a new row).
import { sql, type Kysely, type Selectable } from 'kysely';
import {
  ChargeAttempt,
  Mandate,
  Subscription,
  SubscriptionLedgerEntry,
  type SubscriptionRepository,
} from '@mycel/core';
import type { Database } from '../infra/schema.js';
import { toIso } from '../infra/dates.js';

const read = (row: Selectable<Database['subscriptions']>): Subscription =>
  Subscription.parse({
    id: row.id,
    kind: row.kind,
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    interval: row.interval,
    description: row.description,
    locale: row.locale,
    provider: row.provider,
    supporterId: row.supporter_id,
    mandateId: row.mandate_id,
    startedAt: toIso(row.started_at),
    periodsPaid: row.periods_paid,
    paidThrough: toIso(row.paid_through),
    nextChargeAt: toIso(row.next_charge_at),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    tierId: row.tier_id,
    priceVersion: row.price_version,
    campaignId: row.campaign_id,
    failedAttempts: row.failed_attempts,
    endReason: row.end_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });

const readAttempt = (row: Selectable<Database['charge_attempts']>): ChargeAttempt =>
  ChargeAttempt.parse({
    key: row.key,
    subscriptionId: row.subscription_id,
    paymentId: row.payment_id,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  });

export function subscriptionRepository(
  trx: Kysely<Database>,
  tenantId: string
): SubscriptionRepository {
  const rows = () => trx.selectFrom('subscriptions').selectAll();
  const one = async (q: ReturnType<typeof rows>) => {
    const row = await q.executeTakeFirst();
    return row ? read(row) : null;
  };
  const attempts = () => trx.selectFrom('charge_attempts').selectAll();
  const oneAttempt = async (q: ReturnType<typeof attempts>) => {
    const row = await q.executeTakeFirst();
    return row ? readAttempt(row) : null;
  };
  return {
    async insert(s) {
      await trx
        .insertInto('subscriptions')
        .values({
          id: s.id,
          tenant_id: tenantId,
          kind: s.kind,
          status: s.status,
          amount: s.amount,
          currency: s.currency,
          interval: s.interval,
          description: s.description,
          locale: s.locale,
          provider: s.provider,
          supporter_id: s.supporterId,
          mandate_id: s.mandateId,
          started_at: s.startedAt,
          periods_paid: s.periodsPaid,
          paid_through: s.paidThrough,
          next_charge_at: s.nextChargeAt,
          cancel_at_period_end: s.cancelAtPeriodEnd,
          tier_id: s.tierId,
          price_version: s.priceVersion,
          campaign_id: s.campaignId,
          failed_attempts: s.failedAttempts,
          end_reason: s.endReason,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
        })
        .execute();
    },
    get: (id) => one(rows().where('id', '=', id)),
    lock: (id) => one(rows().where('id', '=', id).forUpdate()),
    async save(s) {
      await trx
        .updateTable('subscriptions')
        .set({
          status: s.status,
          supporter_id: s.supporterId,
          mandate_id: s.mandateId,
          started_at: s.startedAt,
          periods_paid: s.periodsPaid,
          paid_through: s.paidThrough,
          next_charge_at: s.nextChargeAt,
          cancel_at_period_end: s.cancelAtPeriodEnd,
          failed_attempts: s.failedAttempts,
          end_reason: s.endReason,
          updated_at: s.updatedAt,
        })
        .where('id', '=', s.id)
        .execute();
    },
    async list({ status, kind, supporterId }, offset, limit) {
      let q = rows();
      if (status) q = q.where('status', '=', status);
      if (kind) q = q.where('kind', '=', kind);
      if (supporterId) q = q.where('supporter_id', '=', supporterId);
      const found = await q
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .offset(offset)
        .limit(limit)
        .execute();
      return found.map(read);
    },
    async due(now, limit) {
      const found = await rows()
        .where('status', '=', 'active')
        .where('next_charge_at', '<=', new Date(now))
        .orderBy('next_charge_at')
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
          payment_id: null,
          subscription_id: e.subscriptionId,
          seq: sql<number>`(select coalesce(max(seq), 0) + 1 from ledger_entries
                            where tenant_id = ${tenantId} and subscription_id = ${e.subscriptionId})`,
          from_status: e.from,
          to_status: e.to,
          step: e.step,
          cause: e.cause,
          // A subscription step has no word of the provider's; the column is shared with payments.
          provider_status: '',
          paid_through: e.paidThrough,
          failed_attempts: e.failedAttempts,
          amount: e.amount,
          currency: e.currency,
          at: e.at,
          actor: JSON.stringify(e.actor),
        })
        .execute();
    },
    async ledger(subscriptionId) {
      const found = await trx
        .selectFrom('ledger_entries')
        .selectAll()
        .where('subscription_id', '=', subscriptionId)
        .orderBy('seq')
        .execute();
      return found.map((row) =>
        SubscriptionLedgerEntry.parse({
          id: row.id,
          subscriptionId: row.subscription_id,
          from: row.from_status,
          to: row.to_status,
          step: row.step,
          cause: row.cause,
          paidThrough: toIso(row.paid_through),
          failedAttempts: row.failed_attempts,
          amount: row.amount,
          currency: row.currency,
          at: toIso(row.at),
          actor: row.actor,
        })
      );
    },
    async insertMandate(m) {
      await trx
        .insertInto('mandates')
        .values({
          id: m.id,
          tenant_id: tenantId,
          provider: m.provider,
          customer_ref: m.customerRef,
          mandate_ref: m.mandateRef,
          status: m.status,
          method: m.method,
          supporter_id: m.supporterId,
          created_at: m.createdAt,
          updated_at: m.updatedAt,
        })
        .execute();
    },
    async getMandate(id) {
      const row = await trx
        .selectFrom('mandates')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      return row
        ? Mandate.parse({
            id: row.id,
            provider: row.provider,
            customerRef: row.customer_ref,
            mandateRef: row.mandate_ref,
            status: row.status,
            method: row.method,
            supporterId: row.supporter_id,
            createdAt: toIso(row.created_at),
            updatedAt: toIso(row.updated_at),
          })
        : null;
    },
    async insertAttempt(a) {
      await trx
        .insertInto('charge_attempts')
        .values({
          tenant_id: tenantId,
          key: a.key,
          subscription_id: a.subscriptionId,
          payment_id: a.paymentId,
          status: a.status,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
        })
        .execute();
    },
    getAttempt: (key) => oneAttempt(attempts().where('key', '=', key)),
    async saveAttempt(a) {
      await trx
        .updateTable('charge_attempts')
        .set({ status: a.status, updated_at: a.updatedAt })
        .where('key', '=', a.key)
        .execute();
    },
    async attempts(subscriptionId) {
      const found = await attempts()
        .where('subscription_id', '=', subscriptionId)
        .orderBy('created_at')
        .orderBy('key')
        .execute();
      return found.map(readAttempt);
    },
    attemptOfPayment: (paymentId) => oneAttempt(attempts().where('payment_id', '=', paymentId)),
    async stale(before, limit) {
      const found = await attempts()
        // An `unknown` attempt waits as long as a `pending` one: a request that timed out may
        // still land at the provider, and asking at once would read "made nothing" too early.
        .where('status', 'in', ['pending', 'unknown'])
        .where('updated_at', '<', new Date(before))
        .orderBy('updated_at')
        .orderBy('key')
        .limit(limit)
        .execute();
      return found.map(readAttempt);
    },
  };
}
