// `mail_sends` in memory: the intent rows that make a delivery at-most-once (ADR 019 rule 6).

import type { MailSend, MailSendsRepository } from '../../mailing/ports.js';
import type { TenantStore } from './store.js';

export function memoryMailSends(s: TenantStore): MailSendsRepository {
  return {
    get: async (key) => {
      const row = s.mailSends.get(key);
      return row ? { ...row } : null;
    },
    // The conditional upsert of the Postgres repository, one statement there and one
    // synchronous step here: nothing awaits between the check and the write.
    async claim(intent, { at, until, expected }) {
      const row = s.mailSends.get(intent.key);
      if (row) {
        const leased = row.claimedUntil !== null && row.claimedUntil > at;
        if (row.sentAt || row.abandonedAt || leased) return null;
        if ((row.attemptedAt?.getTime() ?? null) !== (expected?.getTime() ?? null)) return null;
      }
      const next: MailSend = {
        key: intent.key,
        subscriber: intent.subscriber,
        eventId: intent.eventId,
        sentAt: null,
        abandonedAt: null,
        providerId: null,
        lastError: null,
        ...row,
        correlation: intent.correlation,
        attemptedAt: new Date(at),
        claimedUntil: new Date(until),
        attempts: (row?.attempts ?? 0) + 1,
      };
      s.mailSends.set(intent.key, next);
      return { ...next };
    },
    async sent(key, at, providerId) {
      const row = s.mailSends.get(key);
      if (row) s.mailSends.set(key, { ...row, sentAt: new Date(at), providerId });
    },
    async failed(key, error, at) {
      const row = s.mailSends.get(key);
      if (row) s.mailSends.set(key, { ...row, lastError: error, claimedUntil: new Date(at) });
    },
    async abandon(key, at) {
      const row = s.mailSends.get(key);
      if (row && !row.sentAt && !row.abandonedAt)
        s.mailSends.set(key, { ...row, abandonedAt: new Date(at) });
    },
    siblings: async (correlation, { since, until }) =>
      [...s.mailSends.values()]
        .filter(
          (m) =>
            m.correlation === correlation &&
            m.attemptedAt !== null &&
            m.attemptedAt >= since &&
            m.attemptedAt <= until
        )
        .map((m) => ({ ...m })),
    unresolved: async (now) =>
      [...s.mailSends.values()]
        .filter(
          (m) =>
            m.attemptedAt !== null &&
            m.sentAt === null &&
            (m.claimedUntil === null || m.claimedUntil <= now)
        )
        .map((m) => ({ ...m })),
  };
}
