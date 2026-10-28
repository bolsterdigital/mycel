import { describe, expect, it } from 'vitest';
import { UseCaseError } from '../errors.js';
import { parseEntitlementsDocument, parseTenantStatus, planTenant } from './platform.js';

const platform = {
  domain: 'mycel.test',
  devHosts: ['localhost'],
  platformOrigin: 'https://admin.mycel.test',
};

const refusal = (fn: () => unknown): UseCaseError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UseCaseError);
    return e as UseCaseError;
  }
  throw new Error('expected a refusal');
};

describe('planTenant', () => {
  it('fills in the defaults and derives the platform hostname', () => {
    expect(planTenant({ slug: 'bij1', name: 'BIJ1', locales: [] }, platform)).toEqual({
      slug: 'bij1',
      name: 'BIJ1',
      locales: ['nl'],
      defaultLocale: 'nl',
      entitlements: {},
      hostname: 'bij1.mycel.test',
    });
    expect(
      planTenant({ slug: 'spd', name: 'SPD', locales: ['de', 'en'] }, platform).defaultLocale
    ).toBe('de');
  });

  it.each(['a', 'Bij1', '-bij1', 'bij_1', 'x'.repeat(64)])('refuses slug %s', (slug) => {
    const e = refusal(() => planTenant({ slug, name: 'n', locales: ['nl'] }, platform));
    expect(e.code).toBe('invalid_input');
    expect(e.issues).toEqual([{ path: 'slug', message: 'invalid' }]);
  });

  it('refuses a slug whose hostname is the admin', () => {
    expect(
      refusal(() => planTenant({ slug: 'admin', name: 'n', locales: ['nl'] }, platform)).code
    ).toBe('conflict');
  });

  it('refuses a default locale outside the list', () => {
    const e = refusal(() =>
      planTenant({ slug: 'bij1', name: 'n', locales: ['nl'], defaultLocale: 'en' }, platform)
    );
    expect(e.issues).toEqual([{ path: 'defaultLocale', message: 'invalid' }]);
  });

  it('refuses entitlements outside the schema', () => {
    const e = refusal(() =>
      planTenant({ slug: 'bij1', name: 'n', locales: ['nl'], entitlements: { nope: 1 } }, platform)
    );
    expect(e.message).toBe('entitlements do not match the schema');
  });
});

describe('parseEntitlementsDocument and parseTenantStatus', () => {
  it('accept what the schema accepts', () => {
    expect(parseEntitlementsDocument({ api_keys: false })).toEqual({ api_keys: false });
    expect(parseTenantStatus('suspended')).toBe('suspended');
  });

  it('refuse anything else as invalid input', () => {
    expect(refusal(() => parseEntitlementsDocument([])).code).toBe('invalid_input');
    expect(refusal(() => parseTenantStatus('deleted')).issues).toEqual([
      { path: 'status', message: 'invalid' },
    ]);
  });
});
