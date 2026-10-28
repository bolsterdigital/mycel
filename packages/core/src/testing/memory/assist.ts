// AI-suggestion settings, suggestions and the monthly usage counter in memory.

import type { AssistRepository } from '../../assist/ports.js';
import type { TenantStore } from './store.js';

export function memoryAssist(s: TenantStore): AssistRepository {
  return {
    settings: async () => structuredClone(s.assistSettings),
    saveSettings: async (settings) => {
      s.assistSettings = structuredClone(settings);
    },
    lockQuota: async () => {},
    countSince: async (since) => s.assistUsage.get(since.toISOString().slice(0, 7)) ?? 0,
    pendingCount: async (since) =>
      [...s.suggestions.values()].filter((v) => v.status === 'pending' && v.createdAt >= since)
        .length,
    countByOperatorSince: async (operatorId, since) =>
      [...s.suggestions.values()].filter(
        (v) => v.requestedBy === operatorId && v.createdAt >= since
      ).length,
    insert: async (row) => {
      s.suggestions.set(row.id, structuredClone(row));
      const month = row.createdAt.toISOString().slice(0, 7);
      s.assistUsage.set(month, (s.assistUsage.get(month) ?? 0) + 1);
    },
    get: async (id) => structuredClone(s.suggestions.get(id) ?? null),
    list: async (itemId) =>
      [...s.suggestions.values()].filter((v) => v.itemId === itemId).map((v) => structuredClone(v)),
    async complete(id, patch) {
      const row = s.suggestions.get(id);
      if (!row || row.status !== 'pending') return false;
      s.suggestions.set(id, { ...row, ...patch });
      return true;
    },
    async decide(id, status, at) {
      const row = s.suggestions.get(id);
      if (
        !row ||
        (status === 'accepted'
          ? row.status !== 'ready'
          : !['ready', 'failed', 'pending'].includes(row.status))
      )
        return false;
      s.suggestions.set(id, { ...row, status, value: null, updatedAt: at });
      return true;
    },
    async deleteBefore(before) {
      let deleted = 0;
      for (const [id, row] of s.suggestions)
        if (row.createdAt < before) {
          s.suggestions.delete(id);
          deleted++;
        }
      return deleted;
    },
  };
}
