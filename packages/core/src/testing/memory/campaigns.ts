// Campaigns in memory (ADR 033), with the same unique keys on landing page and form as 0049.

import type { CampaignRepository } from '../../campaigns/ports.js';
import type { Campaign } from '../../campaigns/model.js';
import {
  afterParticipant,
  compareParticipants,
  type CampaignParticipant,
} from '../../campaigns/participants.js';
import type { TenantStore } from './store.js';

export function memoryCampaigns(s: TenantStore): CampaignRepository {
  const rows = s.campaigns;
  const parts = s.participations;
  const key = (campaignId: string, supporterId: string) => `${campaignId} ${supporterId}`;
  const find = (keep: (c: Campaign) => boolean) =>
    structuredClone([...rows.values()].find(keep) ?? null);
  return {
    get: async (id) => structuredClone(rows.get(id) ?? null),
    lock: async (id) => structuredClone(rows.get(id) ?? null),
    byLandingItem: async (itemId) => find((c) => c.landingItemId === itemId),
    byForm: async (formId) => find((c) => c.formId === formId),
    shareByForm: async (formId) => find((c) => c.formId === formId),
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
    async recordParticipation(p) {
      const row = parts.get(key(p.campaignId, p.supporterId));
      if (row && !row.withdrawnAt) return 'unchanged';
      parts.set(key(p.campaignId, p.supporterId), { ...p, withdrawnAt: null });
      return row ? 'renewed' : 'inserted';
    },
    async withdrawParticipation(campaignId, supporterId, at) {
      const row = parts.get(key(campaignId, supporterId));
      if (!row || row.withdrawnAt) return false;
      row.withdrawnAt = at;
      return true;
    },
    participation: async (campaignId, supporterId) =>
      structuredClone(parts.get(key(campaignId, supporterId)) ?? null),
    async activeCounts(ids) {
      const counts = new Map<string, number>();
      for (const p of parts.values())
        if (ids.includes(p.campaignId) && !p.withdrawnAt)
          counts.set(p.campaignId, (counts.get(p.campaignId) ?? 0) + 1);
      return counts;
    },
    participationsSince: async (from, until) =>
      [...parts.values()]
        .filter((p) => {
          const at = Date.parse(p.confirmedAt);
          return !p.withdrawnAt && at >= from.getTime() && at <= until.getTime();
        })
        .sort((a, b) => Date.parse(a.confirmedAt) - Date.parse(b.confirmedAt))
        .map((p) => ({ campaignId: p.campaignId, supporterId: p.supporterId, at: p.confirmedAt })),
    async participants(campaignId, { after, limit }) {
      const emails = new Map([...s.projections.values()].map((p) => [p.id, p.email]));
      const all = [...parts.values()]
        .filter((p) => p.campaignId === campaignId && emails.has(p.supporterId))
        .map((p): CampaignParticipant => ({
          supporterId: p.supporterId,
          email: emails.get(p.supporterId)!,
          confirmedAt: p.confirmedAt,
          withdrawnAt: p.withdrawnAt,
        }))
        .sort(compareParticipants);
      return {
        rows: all.filter((p) => !after || afterParticipant(p, after)).slice(0, limit),
        total: all.length,
        active: all.filter((p) => !p.withdrawnAt).length,
      };
    },
  };
}
