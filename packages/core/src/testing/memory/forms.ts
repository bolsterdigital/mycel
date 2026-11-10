// Forms, submissions and the rate limiter that guards them, in memory.

import {
  checkCooldown,
  type FormRepository,
  type RateLimiter,
  type SubmissionRepository,
} from '../../forms/ports.js';
import { parseFormDefinition } from '../../forms/model.js';
import type { Clock } from '../../ports.js';
import type { TenantStore } from './store.js';

export function memoryForms(s: TenantStore): FormRepository {
  return {
    lock: async (id) =>
      structuredClone(s.forms.has(id) ? parseFormDefinition(s.forms.get(id)) : null),
    list: async () => structuredClone([...s.forms.values()].map(parseFormDefinition)),
    async save(base, value) {
      const stored = s.forms.get(base.id);
      if (!stored || JSON.stringify(parseFormDefinition(stored)) !== JSON.stringify(base))
        return false;
      s.forms.set(value.id, structuredClone(value));
      return true;
    },
    findById: async (id) =>
      structuredClone(s.forms.has(id) ? parseFormDefinition(s.forms.get(id)) : null),
    insert: async (form) => void s.forms.set(form.id, parseFormDefinition(form)),
  };
}

export function memorySubmissions(s: TenantStore): SubmissionRepository {
  return {
    list: async (formId) =>
      structuredClone(
        [...s.submissions.values()]
          .filter((s) => s.formId === formId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 100)
      ),
    insert: async (sub) => void s.submissions.set(sub.id, structuredClone(sub)),
    // A copy, like a row from Postgres: a caller mutating it changes nothing stored.
    findById: async (id) => structuredClone(s.submissions.get(id) ?? null),
    findByFeedBusinessId: async (id) =>
      structuredClone(
        [...s.submissions.values()].find((sub) =>
          sub.evaluation?.feedActions?.some((p) => p.businessId === id)
        ) ?? null
      ),
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

export function memoryFormMail(s: TenantStore): import('../../forms/ports.js').FormMailRepository {
  return {
    get: async () => structuredClone(s.formMail),
    async save(baseVersion, value) {
      if (s.formMail.version !== baseVersion) return null;
      s.formMail = { version: baseVersion + 1, value: structuredClone(value) };
      return structuredClone(s.formMail);
    },
    async reserveBudget(month, count, max) {
      const used = s.formMailBudget.month === month ? s.formMailBudget.used : 0;
      if (used + count > max) return false;
      s.formMailBudget = { month, used: used + count };
      return true;
    },
  };
}

export function memoryFormFeeds(s: TenantStore): import('../../forms/ports.js').FormFeedRepository {
  return {
    get: async () => structuredClone(s.formFeeds),
    async save(baseVersion, value, actor) {
      if (s.formFeeds.version !== baseVersion) return null;
      s.formFeeds = structuredClone({ version: baseVersion + 1, value, actor });
      return structuredClone(s.formFeeds);
    },
  };
}
