// A member's read state for the attention list: one moment per membership
// (`tenant_memberships.attention_seen_at`, 0034). Its own port rather than two more methods on
// `MembershipRepository`, because it is written on every read of the list by the member itself,
// not by an administrator managing members, and needs none of that repository's lock.

export interface AttentionReads {
  /** Until when this operator has read the list on this site; null before the first read. */
  seenAt(operatorId: string): Promise<Date | null>;
  /**
   * Moves the moment forward to `at`, never back, so two tabs cannot undo each other. Returns the
   * stored moment; null when the operator is not a member of this site.
   */
  markSeen(operatorId: string, at: Date): Promise<Date | null>;
}

declare module '../ports.js' {
  interface TransactionContext {
    attentionReads: AttentionReads;
  }
}
