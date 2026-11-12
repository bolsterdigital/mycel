// Storage of campaigns (ADR 033). Binding takes the lock of the landing item and of the form
// first, so two requests binding one page or one form run one after the other and the second
// sees the first; the unique keys stay as the store's backstop. Rejected: uniqueness only in the
// use case (a race passes it twice) and only in the store (an unlocked race aborts the
// transaction with a constraint error instead of a typed refusal).
import type { Campaign, CampaignKind } from './model.js';

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
  /** Newest first. */
  list(filter: CampaignFilter, offset: number, limit: number): Promise<Campaign[]>;
  /** False: the landing page or the form is already bound; the caller refuses, it does not go on. */
  insert(campaign: Campaign): Promise<boolean>;
  /**
   * Writes `campaign` only while the stored row still has `baseUpdatedAt` (ADR 027); false when
   * it changed in between or is gone.
   */
  update(campaign: Campaign, baseUpdatedAt: string): Promise<boolean>;
}

declare module '../ports.js' {
  interface TransactionContext {
    campaigns: CampaignRepository;
  }
}
