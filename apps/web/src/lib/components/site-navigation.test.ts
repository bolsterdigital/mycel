// The bar's fitting rule (brief site-navigation § 2): the longest prefix of the candidates that
// fits, in their order, with a margin before growing so a width on a boundary does not flicker.
// The DOM adapter around it is proven in the browser (e2e/lib/site-navigation/visitor.ts).
import { describe, expect, it } from 'vitest';
import { actionFit, fit, priority, stickyFits } from '../../../static/_site/navigation.js';

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

// Which part leaves the bar first on a narrowing screen (brief public-chrome-polish § Eén rij op
// smal): the links, then the name beside a logo, then the second call to action, then Language,
// then Search.
describe('site navigation yield order', () => {
  const parts = { search: 'S', languages: 'L', second: 'C2', links: ['A', 'B'] };

  it('shows Search, Language, the second call to action, then the links', () => {
    expect(priority(parts)).toEqual(['S', 'L', 'C2', 'A', 'B']);
  });

  // MY-266 PR F: beside a logo the visible name leaves after the links and before the second call
  // to action; a site without a logo has no name candidate, so its name never leaves.
  it('puts the name beside a logo between the second call to action and the links', () => {
    expect(priority({ ...parts, name: 'N' })).toEqual(['S', 'L', 'C2', 'N', 'A', 'B']);
    const order = priority({ ...parts, name: 'N' });
    const costs = [70, 60, 90, 80, 50, 50];
    const kept = (available: number) => order.slice(0, fit({ costs, available, slack: 0 }));
    expect(kept(300)).toEqual(['S', 'L', 'C2', 'N']);
    expect(kept(299)).toEqual(['S', 'L', 'C2']);
  });

  it('drops what a site does not have', () => {
    expect(priority({ search: 'S', languages: null, second: undefined, links: ['A'] })).toEqual([
      'S',
      'A',
    ]);
  });

  it('lets the links leave first and Search last as the room shrinks', () => {
    const order = priority(parts);
    const costs = [70, 60, 90, 50, 50];
    const kept = (available: number) => order.slice(0, fit({ costs, available, slack: 0 }));
    expect(kept(320)).toEqual(['S', 'L', 'C2', 'A', 'B']);
    expect(kept(270)).toEqual(['S', 'L', 'C2', 'A']);
    expect(kept(269)).toEqual(['S', 'L', 'C2']);
    expect(kept(219)).toEqual(['S', 'L']);
    expect(kept(129)).toEqual(['S']);
    expect(kept(69)).toEqual([]);
  });
});

describe('site header sticky rule', () => {
  it('sticks one row of at most a fifth of the viewport', () => {
    expect(stickyFits({ oneRow: true, height: 76, viewport: 900 })).toBe(true);
    expect(stickyFits({ oneRow: true, height: 180, viewport: 900 })).toBe(true);
    expect(stickyFits({ oneRow: true, height: 181, viewport: 900 })).toBe(false);
  });

  it('never sticks a header of two rows, or one not laid out', () => {
    expect(stickyFits({ oneRow: false, height: 76, viewport: 900 })).toBe(false);
    expect(stickyFits({ oneRow: true, height: 0, viewport: 900 })).toBe(false);
  });
});

describe('the first call to action', () => {
  it('keeps its width while the row fits', () => {
    expect(actionFit({ available: 0, natural: 200, narrowest: 90 })).toBe('natural');
    expect(actionFit({ available: 40, natural: 200, narrowest: 90 })).toBe('natural');
  });

  it('wraps its label when the longest word makes the row fit', () => {
    expect(actionFit({ available: -110, natural: 200, narrowest: 90 })).toBe('tight');
    expect(actionFit({ available: -60, natural: 200, narrowest: 90 })).toBe('tight');
  });

  it('leaves the bar when even its longest word overflows the row (MY-284)', () => {
    expect(actionFit({ available: -111, natural: 200, narrowest: 90 })).toBe('out');
  });
});
