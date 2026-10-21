import { describe, expect, it } from 'vitest';
import { onPlatformOrigin, safeReturn, windowLimiter } from './admin-paths.js';

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

describe('windowLimiter', () => {
  it('allows max hits per window per key', () => {
    let t = 0;
    const hit = windowLimiter(2, 1000, () => t);
    expect([hit('a'), hit('a'), hit('a'), hit('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(hit('a')).toBe(true);
  });
});
