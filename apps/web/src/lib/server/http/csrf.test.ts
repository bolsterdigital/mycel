// The origin check that replaces SvelteKit's (csrf.ts): the same refusals as the framework's rule,
// and the one exempt route. Each negative case would pass if the check were taken away.
import { describe, expect, it } from 'vitest';
import { ONE_CLICK_ROUTE, csrfForbidden, csrfRefusal } from './csrf.js';

const SELF = 'https://probe.example';
const PAGE = '/(public)/[tenant]/unsubscribe';

const post = (headers: Record<string, string>, method = 'POST') =>
  new Request(`${SELF}/unsubscribe`, { method, headers, body: method === 'GET' ? null : 'x' });

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

describe('csrfForbidden', () => {
  it('refuses a form post from another origin or without an Origin, as SvelteKit did', () => {
    expect(csrfForbidden(post({ ...FORM, origin: 'https://evil.example' }), SELF, PAGE)).toBe(true);
    expect(csrfForbidden(post(FORM), SELF, PAGE)).toBe(true);
    expect(
      csrfForbidden(post({ 'content-type': 'multipart/form-data; boundary=x' }), SELF, PAGE)
    ).toBe(true);
    expect(csrfForbidden(post({ 'content-type': 'Text/Plain;charset=utf-8' }), SELF, PAGE)).toBe(
      true
    );
    // `Origin: null` (a `no-referrer` page) is another origin too.
    expect(csrfForbidden(post({ ...FORM, origin: 'null' }), SELF, PAGE)).toBe(true);
    for (const method of ['PUT', 'PATCH', 'DELETE'])
      expect(csrfForbidden(post(FORM, method), SELF, null)).toBe(true);
  });

  it('lets the own origin, a non-form body and a read through', () => {
    expect(csrfForbidden(post({ ...FORM, origin: SELF }), SELF, PAGE)).toBe(false);
    expect(csrfForbidden(post({ 'content-type': 'application/json' }), SELF, PAGE)).toBe(false);
    expect(csrfForbidden(post({ 'content-type': 'application/reports+json' }), SELF, null)).toBe(
      false
    );
    expect(csrfForbidden(new Request(`${SELF}/unsubscribe`), SELF, PAGE)).toBe(false);
  });

  it('exempts only the one-click route, whatever the origin', () => {
    expect(csrfForbidden(post(FORM), SELF, ONE_CLICK_ROUTE)).toBe(false);
    expect(
      csrfForbidden(post({ ...FORM, origin: 'https://mail.example' }), SELF, ONE_CLICK_ROUTE)
    ).toBe(false);
    expect(csrfForbidden(post(FORM), SELF, `${ONE_CLICK_ROUTE}/x`)).toBe(true);
  });
});

describe('csrfRefusal', () => {
  it('answers 403 in SvelteKit’s words, as JSON when asked', async () => {
    const plain = csrfRefusal(post(FORM));
    expect(plain.status).toBe(403);
    expect(await plain.text()).toBe('Cross-site POST form submissions are forbidden');
    const json = csrfRefusal(post({ ...FORM, accept: 'application/json' }));
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({
      message: 'Cross-site POST form submissions are forbidden',
    });
  });
});
