import { describe, expect, it } from 'vitest';
import { siteUrl } from './url.js';

const probe = { slug: 'probe', primaryHostname: 'www.example.org' };

describe('siteUrl', () => {
  it('uses the primary hostname with the scheme and port of the platform origin', () => {
    const prod = { platformOrigin: 'https://admin.mycel.site', siteUrlMode: 'hostnames' as const };
    expect(siteUrl(probe, prod, '/confirm?token=x')).toBe(
      'https://www.example.org/confirm?token=x'
    );
    expect(siteUrl(probe, prod)).toBe('https://www.example.org/');
    const dev = { platformOrigin: 'http://localhost:5173', siteUrlMode: 'hostnames' as const };
    expect(siteUrl({ slug: 'probe', primaryHostname: 'probe.localhost' }, dev, '/signup')).toBe(
      'http://probe.localhost:5173/signup'
    );
  });

  it('falls back to the path form without a primary hostname', () => {
    const prod = { platformOrigin: 'https://admin.mycel.site', siteUrlMode: 'hostnames' as const };
    expect(siteUrl({ slug: 'probe', primaryHostname: null }, prod, '/signup')).toBe(
      'https://admin.mycel.site/probe/signup'
    );
  });

  it('builds the path form in path mode, whatever the hostname', () => {
    const dev = { platformOrigin: 'http://localhost:5173', siteUrlMode: 'path' as const };
    expect(siteUrl(probe, dev, '/confirm?token=x')).toBe(
      'http://localhost:5173/probe/confirm?token=x'
    );
    expect(siteUrl(probe, dev)).toBe('http://localhost:5173/probe');
  });
});
