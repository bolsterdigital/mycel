// The counter of a campaign as the card and the admin read it (ADR 033 rule 8): people as a
// number, a fundraiser's money as an amount in the reader's language, and a goal typed in euros
// kept in cents.
import { describe, expect, it } from 'vitest';
import {
  countFigures,
  goalInput,
  goalMilestones,
  goalTarget,
  milestonesInput,
  startingCountOf,
} from './campaign-count.js';

describe('countFigures', () => {
  it('counts people as a number, against a goal in people', () => {
    expect(countFigures({ participants: 1234, raised: null }, 5000, 'nl')).toEqual({
      value: 1234,
      count: '1.234',
      target: '5.000',
    });
    expect(countFigures({ participants: 7, raised: null }, null, 'en').target).toBeNull();
  });

  it("counts a fundraiser's money, against a goal in the same minor units", () => {
    const raised = { amount: 125_050, currency: 'EUR' };
    const nl = countFigures({ participants: 3, raised }, 500_000, 'nl');
    expect(nl.value).toBe(125_050);
    expect(nl.count.replace(/\s/gu, ' ')).toBe('€ 1.250,50');
    expect(nl.target?.replace(/\s/gu, ' ')).toBe('€ 5.000');
    expect(countFigures({ participants: 3, raised }, 500_000, 'en')).toMatchObject({
      count: '€1,250.50',
      target: '€5,000',
    });
  });
});

describe('the goal field', () => {
  it('reads a fundraiser goal in whole euros and keeps it in cents', () => {
    expect(goalTarget('5000', 'fundraiser')).toBe(500_000);
    expect(goalTarget('500', 'petition')).toBe(500);
    expect(goalTarget(' ', 'fundraiser')).toBeNull();
    expect(goalTarget('12.5', 'fundraiser')).toBeNaN();
    expect(goalInput(500_000, 'fundraiser')).toBe('5000');
    expect(goalInput(500, 'signup')).toBe('500');
    expect(goalInput(null, 'fundraiser')).toBe('');
  });
});

describe('milestones as typed (MY-288)', () => {
  it('reads whole numbers in the unit of the kind, empty as a fixed goal, anything else as null', () => {
    expect(goalMilestones('100, 500', 'petition')).toEqual([100, 500]);
    expect(goalMilestones('100 500;1000', 'petition')).toEqual([100, 500, 1000]);
    expect(goalMilestones('250, 500', 'fundraiser')).toEqual([25_000, 50_000]);
    expect(goalMilestones('  ', 'petition')).toEqual([]);
    expect(goalMilestones('100, 12.5', 'petition')).toBeNull();
    expect(goalMilestones('honderd', 'petition')).toBeNull();
    expect(milestonesInput([25_000, 50_000], 'fundraiser')).toBe('250, 500');
    expect(milestonesInput([], 'petition')).toBe('');
  });
});

describe('a starting count as typed (MY-288 PR B)', () => {
  it('reads a whole number of people, empty as zero, anything else as NaN', () => {
    expect(startingCountOf('1200')).toBe(1200);
    expect(startingCountOf(' ')).toBe(0);
    expect(startingCountOf('12.5')).toBeNaN();
    expect(startingCountOf('-3')).toBeNaN();
  });
});
