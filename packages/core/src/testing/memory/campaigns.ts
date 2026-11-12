// Campaigns in memory (ADR 033), with the same unique keys on landing page and form as 0049.

import type { CampaignRepository } from '../../campaigns/ports.js';
import type { Campaign } from '../../campaigns/model.js';
import type { TenantStore } from './store.js';

export function memoryCampaigns(s: TenantStore): CampaignRepository {
  const rows = s.campaigns;
  const find = (keep: (c: Campaign) => boolean) =>
    structuredClone([...rows.values()].find(keep) ?? null);
  return {
    get: async (id) => structuredClone(rows.get(id) ?? null),
    lock: async (id) => structuredClone(rows.get(id) ?? null),
    byLandingItem: async (itemId) => find((c) => c.landingItemId === itemId),
    byForm: async (formId) => find((c) => c.formId === formId),
    list: async ({ kind, archived }, offset, limit) =>
      structuredClone(
        [...rows.values()]
          .filter((c) => (!kind || c.kind === kind) && !!c.archivedAt === archived)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .slice(offset, offset + limit)
      ),
    async insert(campaign) {
      const taken = [...rows.values()].some(
        (c) =>
          c.landingItemId === campaign.landingItemId ||
          (campaign.formId !== null && c.formId === campaign.formId)
      );
      if (taken) return false;
      rows.set(campaign.id, structuredClone(campaign));
      return true;
    },
    // Synchronous between the read and the write, so atomic like the database's `where`.
    async update(campaign, base) {
      const row = rows.get(campaign.id);
      if (!row || Date.parse(row.updatedAt) !== Date.parse(base)) return false;
      rows.set(campaign.id, structuredClone(campaign));
      return true;
    },
  };
}
