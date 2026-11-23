// The response advertises one same-origin ruleset. The browser suite tests its URL matching.
import { describe, expect, it } from 'vitest';
import { applySpeculationRules } from './speculation.js';

const page = (status = 200, type = 'text/html') =>
  new Response(null, { status, headers: { 'content-type': type } });

describe('applySpeculationRules', () => {
  it('points an HTML document at the common rules URL', () => {
    const response = page();
    applySpeculationRules(response);
    expect(response.headers.get('speculation-rules')).toBe('"/_site/speculation.json"');
  });

  it.each([
    [303, 'text/html'],
    [404, 'text/html'],
    [200, 'application/json'],
    [200, 'image/avif'],
  ])('leaves a %i %s alone', (status, type) => {
    const response = page(status, type);
    applySpeculationRules(response);
    expect(response.headers.has('speculation-rules')).toBe(false);
  });
});
