import { describe, expect, it } from 'vitest';
import { API_CATALOG_LINK, apiCatalog, securityTxt, WELL_KNOWN_API_CATALOG } from './well-known.js';

describe('security.txt', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');

  it('holds the two fields RFC 9116 requires, each on its own line', () => {
    expect(securityTxt('mailto:security@example.org', now)).toBe(
      'Contact: mailto:security@example.org\nExpires: 2027-04-30T12:00:00.000Z\n'
    );
  });

  it('expires in the future and within a year', () => {
    const expires = /Expires: (.+)/.exec(securityTxt('https://example.org/report', now))?.[1];
    const ahead = new Date(expires ?? '').getTime() - now.getTime();
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThan(365 * 24 * 60 * 60 * 1000);
  });
});

describe('api catalog', () => {
  it('anchors a site at its read route and names the OpenAPI document', () => {
    expect(JSON.parse(apiCatalog('https://api.example.org', 'probe'))).toEqual({
      linkset: [
        {
          anchor: 'https://api.example.org/v1/sites/probe',
          'service-desc': [
            {
              href: 'https://api.example.org/openapi.json',
              type: 'application/vnd.oai.openapi+json;version=3.1',
            },
          ],
        },
      ],
    });
  });

  it('anchors a host without a site at the API, and ignores a path in the address', () => {
    const [entry] = (
      JSON.parse(apiCatalog('https://api.example.org/ignored/')) as {
        linkset: { anchor: string }[];
      }
    ).linkset;
    expect(entry?.anchor).toBe('https://api.example.org/v1');
  });

  it('the Link value points at the well-known address', () => {
    expect(API_CATALOG_LINK).toContain(`<${WELL_KNOWN_API_CATALOG}>`);
    expect(API_CATALOG_LINK).toContain('rel="api-catalog"');
  });
});
