// The analytics module's ports (docs/reference/analytics.md): the tenant's setting, a versioned value under the same
// RLS boundary as the other site settings, and the provider transport. The transport takes only
// an `AnalyticsDelivery`, so an adapter cannot be handed a request, a header or a person.
// `NoopAnalytics` is the default for an unset setting, an unconfigured provider and every test.
// Rejected: a transport method per event (the catalogue would live in two places), and putting
// the transport on `TransactionContext` now: the subscriber that calls it arrives with the
// accepted-form event (PR 3) and runs after the commit, not inside a use case's transaction.

import type { AnalyticsDelivery, AnalyticsSettings } from './model.js';

export interface AnalyticsSettingsRepository {
  get(): Promise<{ version: number; value: AnalyticsSettings }>;
  /** Compare-and-set: the next version, or null when the stored version is not `baseVersion`. */
  update(baseVersion: number, value: AnalyticsSettings): Promise<number | null>;
}

/**
 * What became of one delivery. `accepted`: the provider took it. `rejected`: it answered and
 * refused; sending again cannot help. `retryable`: it failed before anything was sent (a refused
 * connection, a 5xx before the body), so one more bounded attempt cannot count twice. `unknown`:
 * it may have arrived (a timeout after sending); the Events API has no idempotency key, so this is
 * never retried blindly. `disabled`: nothing was sent because measurement is off.
 */
export type AnalyticsOutcome = 'accepted' | 'rejected' | 'retryable' | 'unknown' | 'disabled';

export interface Analytics {
  send(delivery: AnalyticsDelivery): Promise<AnalyticsOutcome>;
}

/** Sends nothing and says so; the default wherever no provider is configured. */
export class NoopAnalytics implements Analytics {
  async send(_delivery: AnalyticsDelivery): Promise<AnalyticsOutcome> {
    return 'disabled';
  }
}

declare module '../ports.js' {
  interface TransactionContext {
    analyticsSettings: AnalyticsSettingsRepository;
  }
}
