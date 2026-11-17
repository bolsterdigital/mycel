// The payment state machine as a table (ADR 005 rule 2): every pair of statuses is either a step
// the table names or refused, so a new status is closed until someone opens a step for it.

import { describe, expect, it } from 'vitest';
import { PAYMENT_STEPS, PaymentStatus, canStep, isFinal, pathTo } from './model.js';

const ALL = PaymentStatus.options;

describe('the payment state machine (ADR 005 rule 2)', () => {
  it('allows exactly the steps of the ADR and refuses every other pair', () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canStep(from, to)).map((to) => `${from} → ${to}`)
    );
    expect(allowed).toEqual([
      'created → open',
      'created → failed',
      'open → paid',
      'open → failed',
      'open → expired',
      'paid → refunded',
      'paid → charged_back',
    ]);
    expect(ALL.every((s) => !canStep(s, s))).toBe(true);
  });

  it('names a successor table for every status, and final means none', () => {
    expect(Object.keys(PAYMENT_STEPS).sort()).toEqual([...ALL].sort());
    expect(ALL.filter(isFinal)).toEqual(['failed', 'expired', 'refunded', 'charged_back']);
  });

  it('finds the steps in between when a report skipped some', () => {
    expect(pathTo('open', 'open')).toEqual([]);
    expect(pathTo('open', 'paid')).toEqual(['paid']);
    expect(pathTo('created', 'paid')).toEqual(['open', 'paid']);
    expect(pathTo('open', 'refunded')).toEqual(['paid', 'refunded']);
    expect(pathTo('created', 'charged_back')).toEqual(['open', 'paid', 'charged_back']);
    // A failure before the checkout opened is one step, not a detour through `open`.
    expect(pathTo('created', 'failed')).toEqual(['failed']);
  });

  it('has no way back and no way out of a final status', () => {
    expect(pathTo('paid', 'open')).toBeNull();
    expect(pathTo('paid', 'failed')).toBeNull();
    expect(pathTo('open', 'created')).toBeNull();
    for (const from of ALL.filter(isFinal))
      for (const to of ALL.filter((s) => s !== from)) expect(pathTo(from, to)).toBeNull();
  });

  it('every path is made of allowed steps', () => {
    for (const from of ALL)
      for (const to of ALL) {
        const path = pathTo(from, to);
        if (!path) continue;
        let at = from;
        for (const next of path) {
          expect(canStep(at, next)).toBe(true);
          at = next;
        }
        expect(at).toBe(to);
      }
  });
});
