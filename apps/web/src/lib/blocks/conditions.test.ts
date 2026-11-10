// The display-only evaluator must agree with core for absent, typed and inherited values.
import { describe, it, expect } from 'vitest';
import { matches } from '../../../static/_form/conditions.js';
import { predicateMatches } from '@mycel/core';
describe('conditional form display', () => {
  it('shares the server predicate vocabulary including missing/inactive and inherited keys', () => {
    const predicates = [
      { op: 'equals', fieldId: 'flag', value: true },
      { op: 'not-equals', fieldId: 'constructor', value: false },
      { op: 'present', fieldId: 'flag' },
      {
        op: 'and',
        conditions: [
          { op: 'equals', fieldId: 'flag', value: true },
          { op: 'present', fieldId: 'message' },
        ],
      },
      {
        op: 'or',
        conditions: [
          { op: 'equals', fieldId: 'flag', value: true },
          { op: 'present', fieldId: 'message' },
        ],
      },
    ] as const;
    for (const predicate of predicates)
      for (const values of [
        {},
        { flag: false },
        { flag: true, message: 'Hello' },
        { flag: ['true'] },
        { flag: 1 },
      ] as Record<string, string | number | boolean | string[]>[]) {
        const parsed = JSON.parse(JSON.stringify(predicate));
        expect(matches(parsed, values)).toBe(predicateMatches(parsed, values));
      }
  });
});
