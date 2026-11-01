// The header values per kind of response (brief #20c decision 1). Negative cases: HSTS never
// over plain HTTP and never with includeSubDomains/preload; a route's own value is kept; the
// admin's CSP loses only its frame-ancestors source list.
import { describe, expect, it } from 'vitest';
import {
  applySecurityHeaders,
  CLEAR_ON_LOGOUT,
  denyFraming,
  refusedCrossSite,
  securityHeaders,
  shareable,
} from './security-headers.js';

describe('securityHeaders', () => {
  it.each(['public', 'admin', 'internal'] as const)('%s: the fixed set', (kind) => {
    const h = securityHeaders(kind, false);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['permissions-policy']).toBe(
      'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    );
  });

  it('admin keeps the referrer on its own origin only', () => {
    expect(securityHeaders('admin', true)['referrer-policy']).toBe('same-origin');
    expect(securityHeaders('public', true)['referrer-policy']).toBe(
      'strict-origin-when-cross-origin'
    );
  });

  it('HSTS only over HTTPS, without includeSubDomains or preload', () => {
    expect(securityHeaders('public', false)).not.toHaveProperty('strict-transport-security');
    const hsts = securityHeaders('public', true)['strict-transport-security'];
    expect(hsts).toBe('max-age=31536000');
    expect(hsts).not.toMatch(/includeSubDomains|preload/i);
  });
});

describe('cross-origin isolation', () => {
  it.each(['public', 'admin', 'internal'] as const)('%s keeps to its own origin', (kind) => {
    const h = securityHeaders(kind, true);
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['cross-origin-resource-policy']).toBe('same-origin');
  });

  it('a public file may be used elsewhere, a restricted one may not', () => {
    const file = (cache: string) =>
      shareable(new Response(null, { headers: { 'cache-control': cache } })).headers;
    const open = file('public, max-age=31536000, immutable');
    applySecurityHeaders(open, 'public', true);
    expect(open.get('cross-origin-resource-policy')).toBe('cross-origin');
    const restricted = file('private, no-store');
    applySecurityHeaders(restricted, 'public', true);
    expect(restricted.get('cross-origin-resource-policy')).toBe('same-origin');
  });
});

describe('refusedCrossSite', () => {
  const request = (headers: Record<string, string>, method = 'GET') =>
    new Request('http://x/admin', { method, headers });
  const page = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

  it.each([
    ['no header at all', {}],
    ['its own origin', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }],
    ['a typed address', { 'sec-fetch-site': 'none', ...page }],
    ['a link from a mail', { 'sec-fetch-site': 'cross-site', ...page }],
    ['the redirect back from the login', { 'sec-fetch-site': 'same-site', ...page }],
  ])('lets through %s', (_, headers) => {
    expect(refusedCrossSite(request(headers))).toBe(false);
  });

  it.each(['cross-site', 'same-site'])('refuses a %s subresource, frame or post', (site) => {
    const from = { 'sec-fetch-site': site };
    expect(
      refusedCrossSite(request({ ...from, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))
    ).toBe(true);
    expect(
      refusedCrossSite(request({ ...from, 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }))
    ).toBe(true);
    expect(
      refusedCrossSite(
        request({ ...from, 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })
      )
    ).toBe(true);
    expect(refusedCrossSite(request({ ...from, ...page }, 'POST'))).toBe(true);
  });
});

describe('CLEAR_ON_LOGOUT', () => {
  it('never reaches the cookies of the rest of the registered domain', () => {
    expect(CLEAR_ON_LOGOUT).not.toContain('cookies');
    expect(CLEAR_ON_LOGOUT).not.toContain('*');
  });
});

describe('applySecurityHeaders', () => {
  it('leaves a value the route set itself', () => {
    const headers = new Headers({ 'referrer-policy': 'no-referrer' });
    applySecurityHeaders(headers, 'public', false);
    expect(headers.get('referrer-policy')).toBe('no-referrer');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('tightens frame-ancestors on admin only, keeping nonce and other directives', () => {
    const policy = "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'self'";
    const admin = new Headers({ 'content-security-policy': policy });
    applySecurityHeaders(admin, 'admin', false);
    expect(admin.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'none'"
    );
    const pub = new Headers({ 'content-security-policy': policy });
    applySecurityHeaders(pub, 'public', false);
    expect(pub.get('content-security-policy')).toBe(policy);
    const live = new Headers({ 'content-security-policy': policy });
    applySecurityHeaders(live, 'admin', false, true);
    expect(live.get('content-security-policy')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc'; frame-ancestors 'self'"
    );
  });

  it('adds no CSP where SvelteKit generated none', () => {
    const headers = new Headers();
    applySecurityHeaders(headers, 'admin', true);
    expect(headers.has('content-security-policy')).toBe(false);
  });
});

it('denyFraming appends the directive when the policy has none', () => {
  expect(denyFraming("default-src 'self';")).toBe("default-src 'self'; frame-ancestors 'none'");
});
