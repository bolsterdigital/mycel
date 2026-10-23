import { describe, expect, it } from 'vitest';
import { UseCaseError } from '@mycel/core';
import { failureFor } from './form-post.js';

// Brief form-intake § 4: three classes, never a field error and never the error's own text.
describe('failureFor', () => {
  it('says the site is closed for a capped or suspended site, and reports nothing', () => {
    for (const code of ['limit_exceeded', 'suspended'] as const)
      expect(failureFor(new UseCaseError(code, 'x'), 'nl', 'req-12345678')).toEqual({
        status: 403,
        message: 'Deze site neemt op dit moment geen nieuwe inschrijvingen aan.',
        report: 'none',
      });
  });

  it('asks for a reload on a hand-crafted post, with one info line', () => {
    for (const code of ['not_found', 'invalid_input'] as const) {
      const f = failureFor(new UseCaseError(code, 'no form with id "x"'), 'en', 'req-12345678');
      expect(f).toEqual({
        status: 400,
        message: 'This form could not be processed. Reload the page and try again.',
        report: 'info',
      });
    }
  });

  it('is a 503 with the request id for anything else, and is reported', () => {
    const f = failureFor(new Error('connect ECONNREFUSED 10.0.0.5:5432'), 'nl', 'req-abcdef12');
    expect(f.status).toBe(503);
    expect(f.report).toBe('error');
    expect(f.message).toContain('Kenmerk: req-abcdef12');
    expect(f.message).not.toMatch(/ECONNREFUSED|5432/);
    expect(f.message).not.toBe('Dit veld is verplicht.');
    // An unexpected use-case error is ours too.
    expect(failureFor(new UseCaseError('conflict', 'x'), 'en', 'r').status).toBe(503);
  });
});
