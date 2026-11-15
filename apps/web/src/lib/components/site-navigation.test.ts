// The bar's fitting rule (brief site-navigation § 2): the longest prefix of the candidates that
// fits, in their order, with a margin before growing so a width on a boundary does not flicker.
// The DOM adapter around it is proven in the browser (e2e/lib/site-navigation/visitor.ts).
import { describe, expect, it } from 'vitest';
import { fit } from '../../../static/_site/navigation.js';

describe('site navigation bar fit', () => {
  it('takes the longest prefix that fits', () => {
    expect(fit({ costs: [100, 80, 60], available: 300, slack: 0 })).toBe(3);
    expect(fit({ costs: [100, 80, 60], available: 239, slack: 0 })).toBe(2);
    expect(fit({ costs: [100, 80, 60], available: 99, slack: 0 })).toBe(0);
    expect(fit({ costs: [], available: 500 })).toBe(0);
  });

  it('never skips a long candidate for a later short one', () => {
    // 120 does not fit after 100 in 200, and 20 would: the bar still ends at the first.
    expect(fit({ costs: [100, 120, 20], available: 200, slack: 0 })).toBe(1);
  });

  it('gives nothing when the logo and the tools already leave no room', () => {
    expect(fit({ costs: [40], available: -30 })).toBe(0);
  });

  it('needs slack to grow, but keeps what is shown until it no longer fits', () => {
    // 196 of 200: a new candidate needs 8 px to spare, a shown one only to fit.
    expect(fit({ costs: [100, 96], available: 200, shown: 0, slack: 8 })).toBe(1);
    expect(fit({ costs: [100, 96], available: 200, shown: 2, slack: 8 })).toBe(2);
    expect(fit({ costs: [100, 96], available: 195, shown: 2, slack: 8 })).toBe(1);
    expect(fit({ costs: [100, 96], available: 204, shown: 1, slack: 8 })).toBe(2);
  });
});
