// Provider observations are durable before an external effect. Rejected: inferring a fresh DOI
// from an audience member who was already subscribed before this form submission.
import type { TransactionContext } from '../../ports.js';
export type MailchimpMemberStatus =
  'subscribed' | 'unsubscribed' | 'cleaned' | 'pending' | 'transactional' | 'archived';
export interface MailchimpReceipt {
  intentId: string;
  connectionId: string;
  supporterId: string;
  memberHash: string;
  baselineStatus: MailchimpMemberStatus | 'absent';
  baselineChangedAt: Date | null;
  requestedAt: Date;
  status: MailchimpMemberStatus | 'absent';
  observedAt: Date;
  confirmedAt: Date | null;
  retryable: boolean;
}
export interface MailchimpReceipts {
  forMember(connectionId: string, hash: string): Promise<MailchimpReceipt | null>;
  get(intentId: string): Promise<MailchimpReceipt | null>;
  /** Insert-only baseline: redelivery may observe, but never rewrite the pre-effect evidence. */
  insert(receipt: MailchimpReceipt): Promise<boolean>;
  retryable(intentId: string, value: boolean): Promise<void>;
  observe(
    intentId: string,
    status: MailchimpReceipt['status'],
    at: Date,
    confirmedAt: Date | null
  ): Promise<void>;
}
export interface MailchimpAccount {
  server: string;
  accountId: string;
  accountName: string;
  audiences: {
    id: string;
    name: string;
    fields: { tag: string; name: string; type: string; required: boolean }[];
  }[];
}
export interface MailchimpDiscovery {
  inspect(credential: string): Promise<MailchimpAccount>;
}
export const unavailableMailchimp: MailchimpDiscovery = {
  async inspect() {
    throw new Error('Mailchimp is unavailable');
  },
};
