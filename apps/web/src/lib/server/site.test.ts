// The decision table of brief #14 decision 8: host x path -> serve / 301 / 404 / path form.
import { describe, expect, it } from 'vitest';
import type { ResolvedSite } from '@mycel/core';
import { decideSite, sitePath } from './site.js';

const tenant = {
  id: '01900000-0000-7000-8000-00000000aaaa',
  slug: 'probe',
  name: 'Probe',
  defaultLocale: 'nl',
  locales: ['nl'],
};
const platform = {
  devHosts: ['localhost', '127.0.0.1'],
  platformOrigin: 'https://admin.mycel.site',
  siteUrlMode: 'hostnames' as const,
};
const found = (
  hostname: string,
  kind: 'platform' | 'custom',
  primary: boolean,
  verified: boolean,
  primaryHostname = 'probe.mycel.site'
): ResolvedSite => ({
  tenant,
  hostname: { hostname, kind, primary, verifiedAt: verified ? new Date() : null },
  primaryHostname,
});
const decide = (hostname: string, found: ResolvedSite | null, path = '/signup', search = '') =>
  decideSite({ hostname, path, search, found, platform });

describe('decideSite', () => {
  it('serves the tenant on its primary hostname', () => {
    expect(decide('probe.mycel.site', found('probe.mycel.site', 'platform', true, true))).toEqual({
      kind: 'serve',
      site: { tenant, form: 'hostname', primaryHostname: 'probe.mycel.site' },
    });
  });

  it('redirects a verified non-primary hostname to the primary, keeping path and query', () => {
    expect(
      decide('www.example.org', found('www.example.org', 'custom', false, true), '/signup', '?a=1')
    ).toEqual({ kind: 'redirect', location: 'https://probe.mycel.site/signup?a=1' });
    // The platform hostname redirects too once a custom domain is primary.
    expect(
      decide(
        'probe.mycel.site',
        found('probe.mycel.site', 'platform', false, true, 'www.example.org'),
        '/'
      )
    ).toEqual({ kind: 'redirect', location: 'https://www.example.org/' });
  });

  it('serves nothing on an unverified custom hostname', () => {
    expect(decide('www.example.org', found('www.example.org', 'custom', false, false))).toEqual({
      kind: 'not_found',
    });
    expect(decide('www.example.org', found('www.example.org', 'custom', true, false))).toEqual({
      kind: 'not_found',
    });
  });

  it('reads the tenant from the path on a development host only', () => {
    expect(decide('localhost', null, '/probe/signup')).toEqual({ kind: 'path', slug: 'probe' });
    expect(decide('127.0.0.1', null, '/probe')).toEqual({ kind: 'path', slug: 'probe' });
    expect(decide('localhost', null, '/')).toEqual({ kind: 'root' });
    expect(decide('nope.example', null, '/probe/signup')).toEqual({ kind: 'not_found' });
    expect(
      decideSite({
        ...{ hostname: 'localhost', path: '/probe/signup', search: '', found: null },
        platform: { ...platform, devHosts: [] },
      })
    ).toEqual({ kind: 'not_found' });
  });
});

describe('sitePath', () => {
  it('keeps a visitor in the form they came in on', () => {
    expect(sitePath({ tenant, form: 'hostname' }, '/signup/thanks')).toBe('/signup/thanks');
    expect(sitePath({ tenant, form: 'path' }, '/signup/thanks')).toBe('/probe/signup/thanks');
  });
});
