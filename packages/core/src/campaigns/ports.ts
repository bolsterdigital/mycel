// Storage of campaigns (ADR 033). Binding takes the lock of the landing item and of the form
// first, so two requests binding one page or one form run one after the other and the second
// sees the first; the unique keys stay as the store's backstop. Rejected: uniqueness only in the
// use case (a race passes it twice) and only in the store (an unlocked race aborts the
// transaction with a constraint error instead of a typed refusal).
import type { Campaign, CampaignKind, CampaignParticipation } from './model.js';

export interface CampaignFilter {
  kind?: CampaignKind | undefined;
  /** Archived campaigns are left out unless asked for. */
  archived: boolean;
}

export interface CampaignRepository {
  get(id: string): Promise<Campaign | null>;
  /** The campaign, locked for the rest of the transaction. */
  lock(id: string): Promise<Campaign | null>;
  /** The campaign whose landing page this item is, archived or not. */
  byLandingItem(itemId: string): Promise<Campaign | null>;
  /** The campaign this form is bound to, archived or not. */
  byForm(formId: string): Promise<Campaign | null>;
  /**
   * The same, with a share lock for the rest of the transaction: a submission holds it while it
   * decides, so `campaign.close` (which locks for update) waits for it or it sees the close. Shared,
   * so submissions do not queue behind each other, and taken after the supporter and admission
   * locks, the order the erasure and the ingest also take them in.
   */
  shareByForm(formId: string): Promise<Campaign | null>;
  /** Newest first. */
  list(filter: CampaignFilter, offset: number, limit: number): Promise<Campaign[]>;
  /** False: the landing page or the form is already bound; the caller refuses, it does not go on. */
  insert(campaign: Campaign): Promise<boolean>;
  /**
   * Writes `campaign` only while the stored row still has `baseUpdatedAt` (ADR 027); false when
   * it changed in between or is gone.
   */
  update(campaign: Campaign, baseUpdatedAt: string): Promise<boolean>;
  /**
   * Record a confirmed participation once per supporter (ADR 033 rule 7): `inserted` for the first,
   * `renewed` when a withdrawn one is signed again (the new submission and time replace the old),
   * `unchanged` for a repost or a second confirmation.
   */
  recordParticipation(
    p: Omit<CampaignParticipation, 'withdrawnAt'>
  ): Promise<'inserted' | 'renewed' | 'unchanged'>;
  /** Set the withdrawal time of an active participation; false when none is active. */
  withdrawParticipation(campaignId: string, supporterId: string, at: string): Promise<boolean>;
  participation(campaignId: string, supporterId: string): Promise<CampaignParticipation | null>;
  /** Active (confirmed, not withdrawn) participations per campaign; absent ids count 0. */
  activeCounts(campaignIds: readonly string[]): Promise<Map<string, number>>;
}

declare module '../ports.js' {
  interface TransactionContext {
    campaigns: CampaignRepository;
  }
}
