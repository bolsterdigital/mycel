// Forms, submissions and the rate limiter that guards them, in memory.

import {
  checkCooldown,
  type FormRepository,
  type RateLimiter,
  type SubmissionRepository,
} from '../../forms/ports.js';
import type { Clock } from '../../ports.js';
import type { TenantStore } from './store.js';

export function memoryForms(s: TenantStore): FormRepository {
  return {
    findById: async (id) => s.forms.get(id) ?? null,
    insert: async (form) => void s.forms.set(form.id, structuredClone(form)),
  };
}

export function memorySubmissions(s: TenantStore): SubmissionRepository {
  return {
    insert: async (sub) => void s.submissions.set(sub.id, structuredClone(sub)),
    // A copy, like a row from Postgres: a caller mutating it changes nothing stored.
    findById: async (id) => structuredClone(s.submissions.get(id) ?? null),
    async confirm(id, at) {
      const sub = s.submissions.get(id);
      if (!sub || sub.confirmedAt) return false;
      sub.confirmedAt = new Date(at);
      return true;
    },
  };
}

export function memoryRateLimits(s: TenantStore, clock: Clock): RateLimiter {
  return {
    async hit(key, { max, windowSeconds }) {
      const window = Math.floor(clock.now().getTime() / (windowSeconds * 1000));
      const k = `${key}@${window}`;
      const hits = (s.counters.get(k) ?? 0) + 1;
      s.counters.set(k, hits);
      return hits <= max;
    },
    async cooldown(key, seconds) {
      checkCooldown(seconds);
      const now = clock.now().getTime();
      const last = s.cooldowns.get(key);
      if (last !== undefined && now - last < seconds * 1000) return false;
      s.cooldowns.set(key, now);
      return true;
    },
  };
}
