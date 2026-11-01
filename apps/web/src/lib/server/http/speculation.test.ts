// When a page gets the rules, and that nothing with an effect can match them. The browser's
// behaviour on those rules is measured in e2e/quality-corpus.spec.ts.
import { describe, expect, it } from 'vitest';
import type { Site } from '#lib/server/site.js';
import { SPECULATION_RULES, applySpeculationRules } from './speculation.js';

const page = (status = 200, type = 'text/html') =>
  new Response(null, { status, headers: { 'content-type': type } });
const site = (form: Site['form']) => ({ form, tenant: { slug: 'probe' } }) as Site;

describe('applySpeculationRules', () => {
  it('points a page at the file in the address form the visitor came in on', () => {
    const hostname = page();
    applySpeculationRules(hostname, site('hostname'));
    expect(hostname.headers.get('speculation-rules')).toBe('"/_speculation.json"');
    const path = page();
    applySpeculationRules(path, site('path'));
    expect(path.headers.get('speculation-rules')).toBe('"/probe/_speculation.json"');
  });

  it.each([
    [303, 'text/html'],
    [404, 'text/html'],
    [200, 'application/json'],
    [200, 'image/avif'],
  ])('leaves a %i %s alone', (status, type) => {
    const response = page(status, type);
    applySpeculationRules(response, site('hostname'));
    expect(response.headers.has('speculation-rules')).toBe(false);
  });
});

describe('SPECULATION_RULES', () => {
  const rule = SPECULATION_RULES.prefetch[0]!;

  it('fetches ahead on hover and never prerenders', () => {
    expect(Object.keys(SPECULATION_RULES)).toEqual(['prefetch']);
    expect(rule.eagerness).toBe('moderate');
  });

  it('leaves out every route with a token or an upload, in both address forms, and any query', () => {
    const rules = JSON.stringify(rule);
    for (const path of ['/confirm*', '/*/confirm*', '/media/*', '/*/media/*'])
      expect(rules).toContain(`{"not":{"href_matches":"${path}"}}`);
    expect(rules).toContain('[href*=\\"?\\"]');
  });
});
