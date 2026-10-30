import { describe, expect, it } from 'vitest';
import { FakeClock, MemoryIdentityStore, MemoryStore, MemoryTenants } from '@mycel/core/testing';
import {
  LOGIN_LIMIT,
  adminCookieOptions,
  adminLanguage,
  loginLimiter,
  onPlatformOrigin,
  safeReturn,
} from './admin-paths.js';

describe('safeReturn', () => {
  it.each([
    ['/admin/probe', '/admin/probe'],
    ['/admin', '/admin'],
    ['/admin/probe?tab=keys', '/admin/probe?tab=keys'],
    [null, '/admin'],
    ['', '/admin'],
    ['https://evil.example/admin', '/admin'],
    ['//evil.example/admin', '/admin'],
    ['/\\evil.example', '/admin'],
    ['/probe/signup', '/admin'],
    ['/administrator', '/admin'],
    ['/admin/../probe', '/admin'],
    ['/admin/login?return=/admin', '/admin'],
    ['/admin/callback', '/admin'],
    ['admin/probe', '/admin'],
  ])('%s -> %s', (raw, expected) => {
    expect(safeReturn(raw)).toBe(expected);
  });
});

describe('onPlatformOrigin', () => {
  it('accepts the PUBLIC_BASE_URL origin only', () => {
    const base = 'https://admin.example.org';
    expect(onPlatformOrigin(new URL('https://admin.example.org/admin'), base)).toBe(true);
    expect(onPlatformOrigin(new URL('https://tenant.example.org/admin'), base)).toBe(false);
    expect(onPlatformOrigin(new URL('http://admin.example.org/admin'), base)).toBe(false);
  });
});

describe('loginLimiter', () => {
  it('counts through the identity port, 20 per 10 minutes per key, then a fresh window', async () => {
    const clock = new FakeClock(new Date('2026-10-22T10:00:00Z'));
    const identity = new MemoryIdentityStore(new MemoryStore(), new MemoryTenants(), clock);
    const allow = loginLimiter(identity);
    const results = [];
    for (let i = 0; i < LOGIN_LIMIT.max + 1; i++) results.push(await allow('a'.repeat(22)));
    expect(results.filter(Boolean)).toHaveLength(LOGIN_LIMIT.max);
    expect(results.at(-1)).toBe(false);
    expect(await allow('b'.repeat(22))).toBe(true);
    clock.advance(LOGIN_LIMIT.windowSeconds * 1000);
    expect(await allow('a'.repeat(22))).toBe(true);
  });
});

// TODO #20c decision 4: the e2e gate runs on http, so the Secure half is proven here.
describe('adminCookieOptions', () => {
  it('is HttpOnly, SameSite=Lax and scoped to /admin', () => {
    expect(adminCookieOptions('http://127.0.0.1:4173', 60)).toEqual({
      path: '/admin',
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 60,
    });
  });

  it('is Secure for an https platform origin', () => {
    expect(adminCookieOptions('https://admin.example.org', 60).secure).toBe(true);
  });
});

describe('adminLanguage', () => {
  it("lets the operator's chosen language win over the browser's (#88)", () => {
    expect(adminLanguage('nl', 'en-GB,en;q=0.9')).toBe('nl');
    expect(adminLanguage('en', 'nl-NL,nl;q=0.9')).toBe('en');
  });

  it('negotiates with the browser without a choice, English as the last resort', () => {
    expect(adminLanguage(null, 'nl-NL,nl;q=0.9,en;q=0.8')).toBe('nl');
    expect(adminLanguage(undefined, 'de-DE,de;q=0.9')).toBe('en');
    expect(adminLanguage(null, null)).toBe('en');
  });
});
