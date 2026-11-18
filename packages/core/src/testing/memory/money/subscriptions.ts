// Subscriptions, mandates, charge attempts and their ledger in memory (0077), with the same order
// and filters as the Postgres adapter; `adapter-rules` runs one scenario over both.

import type { SubscriptionRepository } from '../../../money/ports.js';
import type { TenantStore } from '../store.js';

export function memorySubscriptions(s: TenantStore): SubscriptionRepository {
  const rows = s.subscriptions;
  const attempts = () => [...s.chargeAttempts.values()];
  return {
    async insert(sub) {
      rows.set(sub.id, structuredClone(sub));
    },
    get: async (id) => structuredClone(rows.get(id) ?? null),
    lock: async (id) => structuredClone(rows.get(id) ?? null),
    async save(sub) {
      if (rows.has(sub.id)) rows.set(sub.id, structuredClone(sub));
    },
    list: async ({ status, kind, supporterId }, offset, limit) =>
      structuredClone(
        [...rows.values()]
          .filter(
            (r) =>
              (!status || r.status === status) &&
              (!kind || r.kind === kind) &&
              (!supporterId || r.supporterId === supporterId)
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(offset, offset + limit)
      ),
    due: async (now, limit) =>
      structuredClone(
        [...rows.values()]
          .filter((r) => r.status === 'active' && r.nextChargeAt !== null && r.nextChargeAt <= now)
          .sort(
            (a, b) => a.nextChargeAt!.localeCompare(b.nextChargeAt!) || a.id.localeCompare(b.id)
          )
          .slice(0, limit)
      ),
    async appendLedger(entry) {
      s.subscriptionLedger.push(structuredClone(entry));
    },
    ledger: async (id) =>
      structuredClone(s.subscriptionLedger.filter((e) => e.subscriptionId === id)),
    async insertMandate(mandate) {
      s.mandates.set(mandate.id, structuredClone(mandate));
    },
    getMandate: async (id) => structuredClone(s.mandates.get(id) ?? null),
    async insertAttempt(attempt) {
      if (s.chargeAttempts.has(attempt.key)) throw new Error(`duplicate attempt ${attempt.key}`);
      s.chargeAttempts.set(attempt.key, structuredClone(attempt));
    },
    getAttempt: async (key) => structuredClone(s.chargeAttempts.get(key) ?? null),
    async saveAttempt(attempt) {
      const row = s.chargeAttempts.get(attempt.key);
      if (row)
        s.chargeAttempts.set(attempt.key, {
          ...row,
          status: attempt.status,
          updatedAt: attempt.updatedAt,
        });
    },
    attempts: async (id) =>
      structuredClone(
        attempts()
          .filter((a) => a.subscriptionId === id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
      ),
    attemptOfPayment: async (paymentId) =>
      structuredClone(attempts().find((a) => a.paymentId === paymentId) ?? null),
    stale: async (before, limit) =>
      structuredClone(
        attempts()
          .filter((a) => (a.status === 'unknown' || a.status === 'pending') && a.updatedAt < before)
          .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.key.localeCompare(b.key))
          .slice(0, limit)
      ),
  };
}
