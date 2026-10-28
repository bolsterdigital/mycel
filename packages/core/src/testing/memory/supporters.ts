// Supporters (event log plus projection) and the admission reservations in front of them.

import type { Clock, Ids } from '../../ports.js';
import {
  ADMISSION_WINDOW_MS,
  type SupporterAdmissions,
  type SupporterRepository,
} from '../../supporters/ports.js';
import { sha256Hex } from '../../util/digest.js';
import { normalizeEmail } from '../../util/email.js';
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
  const admissionKey = (email: string) => sha256Hex(`${tenantId}:${normalizeEmail(email)}`);
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
