import { describe, expect, it } from 'vitest';
import { reportBudget, reportLines } from './reports.js';

const csp = (body: Record<string, unknown>, url = 'https://probe.example/a?token=secret') => ({
  type: 'csp-violation',
  url,
  user_agent: 'Browser',
  body,
});

describe('reportLines', () => {
  it('keeps what says which rule fired, on which page, against what', () => {
    expect(
      reportLines([
        csp({
          effectiveDirective: 'script-src-elem',
          blockedURL: 'https://evil.example/x.js?key=secret',
          disposition: 'enforce',
          sample: 'secret',
        }),
      ])
    ).toEqual([
      {
        type: 'csp-violation',
        directive: 'script-src-elem',
        blocked: 'https://evil.example',
        disposition: 'enforce',
        path: '/a',
      },
    ]);
  });

  it('names a blocked sink by its keyword', () => {
    expect(reportLines([csp({ blockedURL: 'trusted-types-sink' })])?.[0]?.blocked).toBe(
      'trusted-types-sink'
    );
  });

  it('believes nothing that does not have the expected form', () => {
    const lines = reportLines([
      { type: 'made-up', body: {} },
      'not a report',
      csp(
        {
          effectiveDirective: 'x y\nforged line',
          blockedURL: 'javascript-free text',
          disposition: 'other',
        },
        'not a url'
      ),
    ]);
    expect(lines).toEqual([{ type: 'csp-violation' }]);
  });

  it('refuses a body that is no batch and reads at most twenty reports of one', () => {
    expect(reportLines({ type: 'csp-violation' })).toBeNull();
    expect(reportLines(Array.from({ length: 50 }, () => csp({})))).toHaveLength(20);
  });
});

describe('reportBudget', () => {
  it('allows 120 lines a minute and says how many it dropped when the next minute starts', () => {
    const budget = reportBudget();
    for (let i = 0; i < 120; i++) expect(budget.take(1000).allowed).toBe(true);
    expect(budget.take(2000)).toEqual({ allowed: false, dropped: 0 });
    expect(budget.take(3000)).toEqual({ allowed: false, dropped: 0 });
    expect(budget.take(61_000)).toEqual({ allowed: true, dropped: 2 });
    expect(budget.take(61_001)).toEqual({ allowed: true, dropped: 0 });
  });
});
