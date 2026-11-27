// The header values per kind of response (brief #20c decision 1). Negative cases: HSTS never
// over plain HTTP and never with includeSubDomains/preload; a route's own value is kept; the
// admin's CSP loses only its frame-ancestors source list; a public page gains only its placed
// integrations' origins.
import { describe, expect, it } from 'vitest';
import {
  applySecurityHeaders,
  CLEAR_ON_LOGOUT,
  denyFraming,
  pageSources,
  refusedCrossSite,
  securityHeaders,
  shareable,
} from './security-headers.js';

describe('securityHeaders', () => {
  it('names the collector on the own origin for every kind of response', () => {
    for (const kind of ['public', 'admin', 'internal'] as const)
      expect(securityHeaders(kind, true)['reporting-endpoints']).toBe('default="/_reports"');
  });

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

  it('adds exactly the placed origins on a public page, never on admin', () => {
    const policy =
      "default-src 'self'; script-src 'self' 'nonce-abc'; connect-src 'self' https://a.example; frame-ancestors 'self'; trusted-types mycel-inert-html";
    const none = { script: [], connect: [], img: [], frame: [], media: [], defaultPolicy: false };
    const players = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com'];
    const pub = new Headers({ 'content-security-policy': policy });
    applySecurityHeaders(pub, 'public', false, false, { ...none, frame: players });
    expect(pub.get('content-security-policy')).toBe(
      `${policy}; frame-src 'self' https://www.youtube-nocookie.com https://player.vimeo.com`
    );
    // An existing frame-src is replaced, not widened; nothing placed leaves the policy as it was.
    expect(
      pageSources(`${policy}; frame-src https://evil.example`, {
        ...none,
        frame: players.slice(0, 1),
      })
    ).toBe(`${policy}; frame-src 'self' https://www.youtube-nocookie.com`);
    expect(pageSources(policy, none)).toBe(policy);
    // A tag manager: the nonce and the config's own sources stay, the origins join them once, a
    // missing directive starts from 'self', and the `default` policy name joins the allowed ones.
    const gtm = 'https://www.googletagmanager.com';
    const tags = pageSources(policy, {
      script: [gtm],
      connect: [gtm, 'https://a.example'],
      img: [gtm],
      frame: [],
      media: [],
      defaultPolicy: true,
    });
    expect(tags).toContain(`script-src 'self' 'nonce-abc' ${gtm}`);
    expect(tags).toContain(`connect-src 'self' https://a.example ${gtm};`);
    expect(tags).toContain(`img-src 'self' ${gtm}`);
    expect(tags).toContain('trusted-types mycel-inert-html default');
    expect(tags).not.toContain('frame-src');
    const admin = new Headers({ 'content-security-policy': policy });
    applySecurityHeaders(admin, 'admin', false, false, { ...none, frame: players, script: [gtm] });
    expect(admin.get('content-security-policy')).not.toMatch(/frame-src|googletagmanager/);
    // A managed video played in the page (MY-305): its CDN for media and requests, `blob:` for
    // the HLS client's stream; a missing media-src starts from 'self'.
    const cdn = 'https://tenant.b-cdn.net';
    const video = pageSources(policy, { ...none, media: ['blob:', cdn], connect: [cdn] });
    expect(video).toContain(`media-src 'self' blob: ${cdn}`);
    expect(video).toContain(`connect-src 'self' https://a.example ${cdn};`);
    expect(video).not.toContain('frame-src');
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
