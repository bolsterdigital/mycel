// Usage, measured on demand inside the tenant's transaction (ADR 015 rule 6): the limit checks
// and `tenant.usage.get` read the same numbers. Rejected: a materialized view, which buys nothing at
// these counts and adds a refresh to reason about.

export interface UsageReader {
  /** Supporters of this tenant (rows of the projection). */
  supporters(): Promise<number>;
  /** Mails with `sent_at` in the current UTC calendar month. */
  mailsThisMonth(): Promise<number>;
  storageBytes(): Promise<number>;
  /** Custom hostnames, verified or not; the platform hostname does not count. */
  customHostnames(): Promise<number>;
  /** Members, pending invitations included: an invitation holds a seat. */
  operators(): Promise<number>;
}

declare module '../ports.js' {
  interface TransactionContext {
    usage: UsageReader;
  }
}
