// The rules the platform's font upload shares with a later tenant use case (MY-302): one family
// per role, at most eight faces, the size limit, the licence's domains, and the read query.
import { describe, expect, it } from 'vitest';
import { Invoker, buildRegistry, systemPrincipal, useCases } from '../index.js';
import { MemoryUnitOfWork, FakeClock } from '../testing/index.js';
import {
  SITE_FONT_FACES_MAX,
  SiteFontLicence,
  checkSiteFontFace,
  preloadFace,
  siteFontFile,
  type SiteFont,
  type SiteFontFace,
} from './site-fonts.js';

const face = (weight: number, style: 'normal' | 'italic' = 'normal'): SiteFontFace => ({
  weight,
  style,
  sha256: 'a'.repeat(64),
  bytes: 10,
});
const licence = { holder: 'Tegenmacht', source: 'Foundry', domains: ['example.org'] };
const existing = (faces: SiteFontFace[]): SiteFont => ({
  role: 'heading',
  family: 'Gottak',
  category: 'sans',
  licence: { ...licence, confirmedAt: new Date(0).toISOString() },
  updatedAt: new Date(0).toISOString(),
  faces,
});
const input = (family = 'Gottak') => ({
  role: 'heading' as const,
  family,
  category: 'sans' as const,
  licence,
});

describe('site font rules', () => {
  it('accepts a first face, a replaced face and faces up to the maximum', () => {
    expect(() =>
      checkSiteFontFace(null, input(), { weight: 700, style: 'normal', size: 10 }, false)
    ).not.toThrow();
    const full = existing(
      [100, 200, 300, 400]
        .flatMap((w) => [face(w), face(w, 'italic')])
        .slice(0, SITE_FONT_FACES_MAX)
    );
    expect(() =>
      checkSiteFontFace(full, input(), { weight: 400, style: 'normal', size: 10 }, false)
    ).not.toThrow();
    expect(() =>
      checkSiteFontFace(full, input(), { weight: 900, style: 'normal', size: 10 }, false)
    ).toThrow('site.font.faces.max');
  });

  it('refuses another family name unless the family is replaced, an odd weight and a large file', () => {
    const one = existing([face(700)]);
    expect(() =>
      checkSiteFontFace(one, input('Nudica'), { weight: 400, style: 'normal', size: 10 }, false)
    ).toThrow('site.font.family.other');
    expect(() =>
      checkSiteFontFace(one, input('Nudica'), { weight: 400, style: 'normal', size: 10 }, true)
    ).not.toThrow();
    expect(() =>
      checkSiteFontFace(null, input(), { weight: 450, style: 'normal', size: 10 }, false)
    ).toThrow('site.font.weight');
    expect(() =>
      checkSiteFontFace(null, input(), { weight: 400, style: 'normal', size: 2 ** 21 }, false)
    ).toThrow('site.font.size');
  });

  it('takes hostnames and one wildcard level as licence domains, nothing else', () => {
    expect(
      SiteFontLicence.parse({ ...licence, domains: ['Example.org', '*.example.org'] }).domains
    ).toEqual(['example.org', '*.example.org']);
    for (const bad of ['localhost', 'https://example.org', 'exa mple.org', '*.*.example.org'])
      expect(SiteFontLicence.safeParse({ ...licence, domains: [bad] }).success).toBe(false);
  });

  it('names a file by role, weight, style and the start of the hash, and preloads the nearest roman', () => {
    expect(siteFontFile('body', face(400))).toBe(`body-400-normal-${'a'.repeat(16)}.woff2`);
    expect(preloadFace([face(300), face(700), face(400, 'italic')], 400)?.weight).toBe(300);
    expect(preloadFace([face(400, 'italic')], 400)).toBeNull();
  });

  it('lists the fonts through the read query with content:read', async () => {
    const uow = new MemoryUnitOfWork({ clock: new FakeClock() });
    const invoker = new Invoker(buildRegistry(), uow);
    const principal = systemPrincipal('00000000-0000-4000-8000-000000000001', 'test');
    expect(await invoker.run(useCases.listSiteFonts, principal, {})).toEqual({ fonts: [] });
  });
});
