// The header values per kind of response (brief #20c decision 1). Negative cases: HSTS never
// over plain HTTP and never with includeSubDomains/preload; a route's own value is kept; the
// admin's CSP loses only its frame-ancestors source list.
import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, denyFraming, securityHeaders } from './security-headers.js';

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
