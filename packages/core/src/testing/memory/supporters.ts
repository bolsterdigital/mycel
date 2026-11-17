// Supporters (event log plus projection), the admission reservations in front of them, and the
// sign-in links and sessions of a supporter who reads (readers/ports.ts).

import type { Clock, Ids } from '../../ports.js';
import {
  ADMISSION_WINDOW_MS,
  type SupporterAdmissions,
  type SupporterRepository,
} from '../../supporters/ports.js';
import { emailKey } from '../../supporters/email-key.js';
import type { ReaderSession, SigninLink } from '../../readers/model.js';
import type { ReaderSessionRepository, SigninLinkRepository } from '../../readers/ports.js';
import type { TenantStore } from './store.js';

export function memorySupporters(s: TenantStore, ids: Ids): SupporterRepository {
  return {
    // No-op: this store is one process and not transactional (see memory.ts). Serialising writers
    // is a Postgres property, proven by the concurrency test in the database conformance.
    async lock() {},
    async resolve(email) {
      const found = [...s.projections.values()].find((p) => p.email === email);
      return found ? { id: found.id, isNew: false } : { id: ids.next(), isNew: true };
    },
    async appendEvent(event) {
      if (s.events.has(event.id)) return false;
      s.events.set(event.id, structuredClone(event));
      return true;
    },
    eventsFor: async (supporterId) =>
      [...s.events.values()].filter((e) => e.supporter_id === supporterId),
    getProjection: async (email) =>
      [...s.projections.values()].find((p) => p.email === email) ?? null,
    getProjectionById: async (id) => s.projections.get(id) ?? null,
    saveProjection: async (p) => void s.projections.set(p.id, structuredClone(p)),
  };
}

export function memoryAdmissions(
  s: TenantStore,
  tenantId: string,
  clock: Clock
): SupporterAdmissions {
  const admissionKey = (email: string) => emailKey(tenantId, email, 'admission');
  const live = (at: Date) => clock.now().getTime() - at.getTime() < ADMISSION_WINDOW_MS;
  return {
    // No-op for the same reason as `supporters.lock`; the Postgres conformance proves the lock.
    async lock() {},
    count: async () => s.projections.size + [...s.admissions.values()].filter(live).length,
    async pending(email) {
      const at = s.admissions.get(await admissionKey(email));
      return at !== undefined && live(at);
    },
    async reserve(email) {
      for (const [k, at] of s.admissions) if (!live(at)) s.admissions.delete(k);
      const key = await admissionKey(email);
      if (!s.admissions.has(key)) s.admissions.set(key, clock.now());
    },
    async release(email) {
      s.admissions.delete(await admissionKey(email));
    },
  };
}

/**
 * Reader sign-in links, with the conditions of the Postgres repository: `consume` checks and
 * writes in one synchronous step, so of two callers one gets the row.
 */
export function memorySigninLinks(s: TenantStore): SigninLinkRepository {
  return {
    insert: async (link) => void s.signinLinks.set(link.id, { ...link }),
    get: async (id) => {
      const row = s.signinLinks.get(id);
      return row ? { ...row } : null;
    },
    async consume(id, tokenHash, at) {
      const row = s.signinLinks.get(id);
      if (!row || row.tokenHash !== tokenHash || row.consumedAt || row.expiresAt <= at) return null;
      const next: SigninLink = { ...row, consumedAt: new Date(at) };
      s.signinLinks.set(id, next);
      return { ...next };
    },
  };
}

export function memoryReaderSessions(s: TenantStore): ReaderSessionRepository {
  const live = (row: ReaderSession | undefined, at: Date) =>
    row && !row.revokedAt && row.expiresAt > at ? row : null;
  return {
    insert: async (session) => void s.readerSessions.set(session.id, { ...session }),
    getLive: async (id, at) => {
      const row = live(s.readerSessions.get(id), at);
      return row ? { ...row } : null;
    },
    async revoke(id, at) {
      const row = live(s.readerSessions.get(id), at);
      if (!row) return false;
      s.readerSessions.set(id, { ...row, revokedAt: new Date(at) });
      return true;
    },
  };
}
