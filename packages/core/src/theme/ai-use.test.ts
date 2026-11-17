import { describe, expect, it } from 'vitest';
import { aiPolicy, ANSWER_AGENTS, robotsTxt, TRAINING_CRAWLERS } from './ai-use.js';
import { SiteGeneral } from './settings.js';

const robots = (use?: 'open' | 'no-training' | 'search-only') =>
  robotsTxt({
    use,
    disallowPaths: ['/admin', '/confirm'],
    sitemap: 'https://a.example/sitemap.xml',
  });

describe('the AI use of a site', () => {
  it('is open by default: every agent may read, nothing is reserved', () => {
    expect(aiPolicy(undefined)).toEqual(aiPolicy('open'));
    expect(aiPolicy('open')).toEqual({
      contentSignal: 'search=yes, ai-input=yes, ai-train=yes',
      disallow: [],
      tdmReservation: false,
    });
    expect(robots()).toBe(
      [
        'User-agent: *',
        'Content-Signal: search=yes, ai-input=yes, ai-train=yes',
        'Disallow: /admin',
        'Disallow: /confirm',
        '',
        'Sitemap: https://a.example/sitemap.xml',
        '',
      ].join('\n')
    );
  });

  it('without training blocks only the training crawlers and reserves mining rights', () => {
    const text = robots('no-training');
    expect(text).toMatch(/^Content-Signal: search=yes, ai-input=yes, ai-train=no$/m);
    for (const agent of TRAINING_CRAWLERS) expect(text).toContain(`User-agent: ${agent}\n`);
    for (const agent of ANSWER_AGENTS) expect(text).not.toContain(agent);
    expect(text).toMatch(/User-agent: Bytespider\nDisallow: \/\n/);
    expect(aiPolicy('no-training').tdmReservation).toBe(true);
  });

  it('search only also turns away the agents that answer with the page, never a search engine', () => {
    const text = robots('search-only');
    expect(text).toMatch(/^Content-Signal: search=yes, ai-input=no, ai-train=no$/m);
    for (const agent of [...TRAINING_CRAWLERS, ...ANSWER_AGENTS])
      expect(text).toContain(`User-agent: ${agent}\n`);
    expect(text).not.toMatch(/Googlebot|Bingbot/i);
    // The `*` group keeps its own rules; the sitemap stays for every crawler.
    expect(text.indexOf('Disallow: /confirm')).toBeLessThan(text.indexOf('User-agent: GPTBot'));
    expect(text.trimEnd().split('\n').at(-1)).toBe('Sitemap: https://a.example/sitemap.xml');
  });

  it('is general site data: optional, and only one of the three steps', () => {
    expect(SiteGeneral.parse({ timeZone: 'UTC' }).aiUse).toBeUndefined();
    expect(SiteGeneral.parse({ timeZone: 'UTC', aiUse: 'no-training' }).aiUse).toBe('no-training');
    expect(SiteGeneral.safeParse({ timeZone: 'UTC', aiUse: 'nothing' }).success).toBe(false);
  });
});
