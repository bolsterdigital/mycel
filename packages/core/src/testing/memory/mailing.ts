// `mail_sends` in memory: the intent rows that make a delivery at-most-once (ADR 019 rule 6).

import type {
  MailAutomationsRepository,
  MailDayCount,
  MailEditionsRepository,
  MailSend,
  MailSendsRepository,
} from '../../mailing/ports.js';
import { dayIn } from '../../ops/model.js';
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
    daily: async (since, now, zone) => {
      const days = new Map<string, MailDayCount>();
      const add = (at: Date, field: 'sent' | 'unknown' | 'abandoned') => {
        if (at < since) return;
        const day = dayIn(at, zone);
        const row = days.get(day) ?? { day, sent: 0, unknown: 0, abandoned: 0 };
        row[field]++;
        days.set(day, row);
      };
      for (const m of s.mailSends.values()) {
        if (m.sentAt) add(m.sentAt, 'sent');
        else if (m.abandonedAt) add(m.abandonedAt, 'abandoned');
        else if (m.attemptedAt && (m.claimedUntil === null || m.claimedUntil <= now))
          add(m.attemptedAt, 'unknown');
      }
      return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
    },
    attemptedSince: async (subscriber, since) =>
      [...s.mailSends.values()].filter(
        (m) => m.subscriber === subscriber && m.attemptedAt !== null && m.attemptedAt >= since
      ).length,
  };
}

/** `mail_editions` in memory: insert once, then only the two delivery fields move. */
export function memoryMailEditions(s: TenantStore): MailEditionsRepository {
  return {
    async insert(edition) {
      if (s.mailEditions.has(edition.id)) throw new Error('edition exists');
      s.mailEditions.set(
        edition.id,
        structuredClone({ ...edition, deliveredThrough: null, completedAt: null })
      );
    },
    get: async (id) => {
      const row = s.mailEditions.get(id);
      return row ? structuredClone(row) : null;
    },
    forItem: async (itemId) =>
      [...s.mailEditions.values()]
        .filter((e) => e.itemId === itemId)
        .sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime() || (a.id < b.id ? 1 : -1))
        .map(({ deliveredThrough: _d, locales, ...e }) =>
          structuredClone({
            ...e,
            locales: locales
              .map(({ locale, subject }) => ({ locale, subject }))
              .sort((a, b) => (a.locale < b.locale ? -1 : 1)),
          })
        ),
    async advance(id, supporterId) {
      const row = s.mailEditions.get(id);
      if (row) row.deliveredThrough = supporterId;
    },
    async complete(id, at) {
      const row = s.mailEditions.get(id);
      if (row && !row.completedAt) row.completedAt = new Date(at);
    },
  };
}

/** `mail_automations` and `mail_automation_runs` in memory (0082): one series per list. */
export function memoryMailAutomations(s: TenantStore): MailAutomationsRepository {
  const runKey = (automationId: string, supporterId: string) => `${automationId}:${supporterId}`;
  return {
    list: async () =>
      [...s.mailAutomations.values()]
        .sort((a, b) => (a.list < b.list ? -1 : 1))
        .map((a) => structuredClone(a)),
    get: async (id) => {
      const row = s.mailAutomations.get(id);
      return row ? structuredClone(row) : null;
    },
    forList: async (list) => {
      const row = [...s.mailAutomations.values()].find((a) => a.list === list);
      return row ? structuredClone(row) : null;
    },
    async save(automation) {
      const other = [...s.mailAutomations.values()].find(
        (a) => a.list === automation.list && a.id !== automation.id
      );
      if (other) throw new Error('a series for this list exists');
      s.mailAutomations.set(automation.id, structuredClone(automation));
    },
    async start(automationId, supporterId, at) {
      const key = runKey(automationId, supporterId);
      if (s.mailAutomationRuns.has(key)) return false;
      s.mailAutomationRuns.set(key, {
        automationId,
        supporterId,
        startedAt: new Date(at),
        through: -1,
      });
      return true;
    },
    run: async (automationId, supporterId) => {
      const row = s.mailAutomationRuns.get(runKey(automationId, supporterId));
      return row ? structuredClone(row) : null;
    },
    async advance(automationId, supporterId, through) {
      const row = s.mailAutomationRuns.get(runKey(automationId, supporterId));
      if (!row || row.through >= through) return false;
      row.through = through;
      return true;
    },
    reach: async (automationId) => {
      const runs = [...s.mailAutomationRuns.values()].filter(
        (r) => r.automationId === automationId
      );
      const steps = s.mailAutomations.get(automationId)?.steps.length ?? 0;
      return {
        started: runs.length,
        reached: Array.from({ length: steps }, (_, i) => runs.filter((r) => r.through >= i).length),
      };
    },
  };
}
