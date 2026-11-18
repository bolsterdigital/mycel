// The subscription state machine, the dunning policy and the period arithmetic as tables (ADR 005
// rules 2 and 5, brief MY-254 PR 1, choices 4 and 5).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUNNING,
  SUBSCRIPTION_STEPS,
  SubscriptionStatus,
  addInterval,
  canStepSubscription,
  chargeKey,
  isSubscriptionFinal,
  nextRetry,
} from './subscription-model.js';

describe('subscription state machine', () => {
  it('allows exactly the steps of ADR 005 rule 2', () => {
    const allowed = SubscriptionStatus.options.flatMap((from) =>
      SubscriptionStatus.options
        .filter((to) => canStepSubscription(from, to))
        .map((to) => `${from}>${to}`)
    );
    expect(allowed).toEqual([
      'pending>active',
      'pending>cancelled',
      'pending>ended',
      'active>paused',
      'active>cancelled',
      'active>ended',
      'paused>active',
      'paused>cancelled',
      'paused>ended',
    ]);
  });

  it('has no way out of cancelled or ended, and no step to the same status', () => {
    expect(SubscriptionStatus.options.filter(isSubscriptionFinal)).toEqual(['cancelled', 'ended']);
    for (const s of SubscriptionStatus.options) expect(SUBSCRIPTION_STEPS[s]).not.toContain(s);
  });
});

describe('nextRetry', () => {
  const due = '2026-03-31T10:00:00.000Z';
  it.each([
    [0, null],
    [1, '2026-04-03T10:00:00.000Z'],
    [2, '2026-04-07T10:00:00.000Z'],
    [3, null],
    [4, null],
  ])('after %i failed attempts tries again at %s', (failed, at) => {
    expect(nextRetry(DEFAULT_DUNNING, failed, due)).toBe(at);
  });

  it('counts from the day the charge was due, not from when it failed', () => {
    expect(nextRetry({ retryAfterDays: [1], graceDays: 0 }, 1, due)).toBe(
      '2026-04-01T10:00:00.000Z'
    );
  });
});

describe('addInterval', () => {
  it.each([
    ['2026-01-31T09:00:00.000Z', 1, 'month', '2026-02-28T09:00:00.000Z'],
    ['2026-01-31T09:00:00.000Z', 2, 'month', '2026-03-31T09:00:00.000Z'],
    ['2028-01-31T09:00:00.000Z', 1, 'month', '2028-02-29T09:00:00.000Z'],
    ['2026-11-15T23:30:00.000Z', 2, 'month', '2027-01-15T23:30:00.000Z'],
    ['2028-02-29T12:00:00.000Z', 1, 'year', '2029-02-28T12:00:00.000Z'],
    ['2028-02-29T12:00:00.000Z', 4, 'year', '2032-02-29T12:00:00.000Z'],
  ] as const)('%s plus %i %s is %s', (anchor, periods, interval, expected) => {
    expect(addInterval(anchor, periods, interval)).toBe(expected);
  });
});

describe('chargeKey', () => {
  it('names the subscription, the period and the attempt', () => {
    expect(chargeKey('s1', '2026-02-28T09:00:00.000Z', 2)).toBe(
      'subscription:s1:2026-02-28T09:00:00.000Z:2'
    );
  });
});
