// Recurring giving as Mycel records it (ADR 005 rules 1, 2, 5 and 7, brief MY-254 PR 1). A
// subscription is a promise to charge an amount every month or year; a mandate is the donor's
// authorisation at the provider that makes those charges possible; a charge attempt is the intent
// row written before each charge (ADR 019 rule 6). The payments a subscription makes are ordinary
// `payments` with `subscriptionId` and a `sequence`, so everything that hangs on a payment (the
// fundraiser's counter, the supporter's page, the reconciliation, the webhook) works for them too.
//
// The state machine is this file, as for payments: a table of allowed steps and pure functions
// over it. Every step, and every step that moves `paidThrough` or counts a failed charge without
// changing the status, is one subscription ledger entry with its cause (rules 1 and 5).
//
// Time is a fact here, never a sweeper's verdict (ADR 019 rule 4): `paidThrough` is stored, and
// whether a member still reads is computed from it plus grace when asked (PR 4). A charge moves
// `paidThrough` one interval on from the old `paidThrough`, not from the day it succeeded, so a
// late charge does not shift the cycle (choice 4).
//
// Rejected: a second history table for subscriptions (one ledger, choice 2), `paused` meaning
// "skip one charge" (it means "charge nothing until resumed"; a skipped month is a note), and the
// dunning policy as tenant settings in this PR (there is no settings document to put it in yet and
// no screen to change it; the defaults are the policy until a site needs another, a note).

import { z } from 'zod';
import { Actor } from '../principal.js';
import { Currency, MinorUnits } from './model.js';

const Timestamp = z.string().datetime({ offset: true });

/** How often a subscription charges (choice 1). A quarter is a note, not an interval. */
export const Interval = z.enum(['month', 'year']);
export type Interval = z.infer<typeof Interval>;

/** What a subscription is for (ADR 005 rule 8): one ledger, a `kind` beside it. */
export const SubscriptionKind = z.enum(['donation', 'membership']);
export type SubscriptionKind = z.infer<typeof SubscriptionKind>;

export const SubscriptionStatus = z.enum(['pending', 'active', 'paused', 'cancelled', 'ended']);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatus>;

/**
 * Every step a subscription may take (ADR 005 rule 2). `cancelled` is a person's decision (the
 * donor, an operator), `ended` everything else (the first payment failed, dunning ran out, an
 * erasure); both are final. A step to the same status is not in the table: it changes no status
 * and is recorded as a ledger entry of its own kind (`renewed`, `charge-failed`).
 */
export const SUBSCRIPTION_STEPS: Readonly<
  Record<SubscriptionStatus, readonly SubscriptionStatus[]>
> = {
  pending: ['active', 'cancelled', 'ended'],
  active: ['paused', 'cancelled', 'ended'],
  paused: ['active', 'cancelled', 'ended'],
  cancelled: [],
  ended: [],
};

export const canStepSubscription = (from: SubscriptionStatus, to: SubscriptionStatus): boolean =>
  SUBSCRIPTION_STEPS[from].includes(to);

export const isSubscriptionFinal = (status: SubscriptionStatus): boolean =>
  SUBSCRIPTION_STEPS[status].length === 0;

/** Why a subscription ended without anyone cancelling it. */
export const EndReason = z.enum(['first-payment', 'dunning', 'erasure', 'period-end']);
export type EndReason = z.infer<typeof EndReason>;

export const Subscription = z.object({
  id: z.string().guid(),
  kind: SubscriptionKind,
  status: SubscriptionStatus,
  amount: MinorUnits,
  currency: Currency,
  interval: Interval,
  /** What the donor reads at the provider and on a statement, for every charge. */
  description: z.string().min(1).max(140),
  locale: z.string().min(2).max(35),
  /** The adapter that holds the mandate; another adapter cannot charge it. */
  provider: z.string().min(1).max(40),
  /** Null until the first payment settles for a form gift, and after an erasure. */
  supporterId: z.string().guid().nullable(),
  /** The authorisation the charges use; null until the first payment is paid. */
  mandateId: z.string().guid().nullable(),
  /**
   * When the current run of periods began: `paidAt` of the first payment, or the day a gift was
   * resumed after its paid period had passed (PR 3); null until the first payment is paid.
   */
  startedAt: Timestamp.nullable(),
  /** Periods paid since `startedAt`; `paidThrough` is `startedAt` plus this many intervals. */
  periodsPaid: z.number().int().nonnegative(),
  /** Until when it is paid (ADR 005 rule 7); null until the first payment is paid. */
  paidThrough: Timestamp.nullable(),
  /** When the next charge is due; null when nothing will be charged (pending, paused, final). */
  nextChargeAt: Timestamp.nullable(),
  /** A membership that stops at `paidThrough` instead of at once (choice 10). */
  cancelAtPeriodEnd: z.boolean(),
  /** For a membership: the paid tier bought and the version of its price (choice 9, rule 7). */
  tierId: z.string().guid().nullable(),
  priceVersion: z.number().int().positive().nullable(),
  /** The fundraiser every charge counts towards (choice 14). */
  campaignId: z.string().guid().nullable(),
  /** Failed charges since the last paid one: the place in the dunning policy. */
  failedAttempts: z.number().int().nonnegative(),
  endReason: EndReason.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Subscription = z.infer<typeof Subscription>;

export const MandateStatus = z.enum(['valid', 'invalid']);

/** A donor's authorisation at the provider (ADR 005 rule 1); references only, no account. */
export const Mandate = z.object({
  id: z.string().guid(),
  provider: z.string().min(1).max(40),
  /** The provider's customer and mandate references. */
  customerRef: z.string().min(1).max(200),
  mandateRef: z.string().min(1).max(200),
  status: MandateStatus,
  /** The provider's word for how it charges (`directdebit`, `creditcard`). */
  method: z.string().min(1).max(40),
  supporterId: z.string().guid().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Mandate = z.infer<typeof Mandate>;

/**
 * An intent row before a charge (ADR 019 rule 6). `pending`: written, the call not answered yet.
 * `sent`: the provider answered and the payment is recorded. `unknown`: the call failed in a way
 * that may or may not have charged; the reconciliation asks the provider by key before anything
 * else. `done`: its payment settled, or the provider, asked by key, never made one.
 */
export const ChargeAttemptStatus = z.enum(['pending', 'sent', 'unknown', 'done']);
export type ChargeAttemptStatus = z.infer<typeof ChargeAttemptStatus>;

export const ChargeAttempt = z.object({
  /** `subscription:<id>:<paidThrough>:<n>`, also the provider's idempotency key. */
  key: z.string().min(1).max(200),
  subscriptionId: z.string().guid(),
  /** The id the payment gets, given before the call so the provider can carry it. */
  paymentId: z.string().guid(),
  status: ChargeAttemptStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ChargeAttempt = z.infer<typeof ChargeAttempt>;

/** The key of the `attempt`-th charge for the period that ends at `paidThrough`. */
export const chargeKey = (subscriptionId: string, paidThrough: string, attempt: number): string =>
  `subscription:${subscriptionId}:${paidThrough}:${attempt}`;

/** What a subscription ledger entry records, beside a change of status. */
export const SubscriptionStep = z.enum([
  'started',
  'activated',
  'renewed',
  'charge-failed',
  'paused',
  'resumed',
  'cancel-at-period-end',
  'cancelled',
  'ended',
  // The giver changed the amount from the next charge (PR 3); the entry carries the new amount.
  'amount-changed',
]);
export type SubscriptionStep = z.infer<typeof SubscriptionStep>;

/** Who or what caused a subscription step. */
export const SubscriptionCause = z.enum([
  'checkout',
  'return',
  'webhook',
  'reconcile',
  'operator',
  'charge',
  'donor',
  'erasure',
]);
export type SubscriptionCause = z.infer<typeof SubscriptionCause>;

export const SubscriptionLedgerEntry = z.object({
  id: z.string().guid(),
  subscriptionId: z.string().guid(),
  /** Null on the first entry. */
  from: SubscriptionStatus.nullable(),
  to: SubscriptionStatus,
  step: SubscriptionStep,
  cause: SubscriptionCause,
  /** Where the subscription stands after the step. */
  paidThrough: Timestamp.nullable(),
  failedAttempts: z.number().int().nonnegative(),
  amount: MinorUnits,
  currency: Currency,
  at: Timestamp,
  actor: Actor,
});
export type SubscriptionLedgerEntry = z.infer<typeof SubscriptionLedgerEntry>;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The dunning policy (ADR 005 rule 5, choice 5): a failed charge is tried again after each delay
 * in turn, and after the last failure the subscription ends. `graceDays` is how long a member
 * keeps reading after `paidThrough` (PR 4). The same for every site until one needs another.
 */
export interface DunningPolicy {
  /** Days after the first failure before the second and third attempt. */
  retryAfterDays: readonly number[];
  graceDays: number;
}

export const DEFAULT_DUNNING: DunningPolicy = { retryAfterDays: [3, 7], graceDays: 14 };

/**
 * When to try again after `failedAttempts` failures counted from the failure at `firstFailedAt`,
 * or null when the policy is spent and the subscription ends. Day 0, then +3, then +7 by default.
 */
export function nextRetry(
  policy: DunningPolicy,
  failedAttempts: number,
  firstFailedAt: string
): string | null {
  const days = policy.retryAfterDays[failedAttempts - 1];
  if (failedAttempts < 1 || days === undefined) return null;
  return new Date(new Date(firstFailedAt).getTime() + days * DAY_MS).toISOString();
}

/**
 * `anchor` plus `periods` intervals, on the calendar: a monthly gift that started on 31 January is
 * paid through the last day of February after one period and through 31 March after two. Counting
 * from the start instead of from the last `paidThrough` keeps the day of the month.
 */
export function addInterval(anchor: string, periods: number, interval: Interval): string {
  const start = new Date(anchor);
  const months = interval === 'month' ? periods : periods * 12;
  const target = new Date(start.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)
  ).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target.toISOString();
}
