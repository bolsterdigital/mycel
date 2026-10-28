// Theme invariants (ADR 013 rule 1, TODO #8b2): the WCAG arithmetic against known values and the
// 4.5:1 boundary, light and dark checked apart, one check behind `site.theme.check` and `Theme`, every
// preset valid, defaults explicit, and no shape that could smuggle CSS or a URL in.

import { describe, expect, it } from 'vitest';
import { UseCaseError } from '../errors.js';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { MemoryUnitOfWork } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { Theme, checkTheme, contrastRatio, resolveTheme } from './check.js';
import { THEME_RANGES, ThemeInput, type Palette } from './model.js';
import { DEFAULT_THEME, THEME_PRESETS } from './presets.js';

const TENANT = '01900000-0000-7000-8000-00000000aaaa';
const light = DEFAULT_THEME.palettes.light;
const dark = DEFAULT_THEME.palettes.dark;
const withLight = (patch: Partial<Palette>) => ({
  palettes: { light: { ...light, ...patch }, dark },
});

describe('contrast arithmetic', () => {
  it('knows black on white and identical colours', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
  });

  it('compares unrounded: #767676 passes 4.5 on white, #777777 does not', () => {
    // 4.54 and 4.48; both would print as "4.5" with one decimal.
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThan(4.5);
    expect(contrastRatio('#777777', '#ffffff')).toBeLessThan(4.5);
    const pass = checkTheme(withLight({ muted: { foreground: '#767676', background: '#ffffff' } }));
    const fail = checkTheme(withLight({ muted: { foreground: '#777777', background: '#ffffff' } }));
    const muted = (r: ReturnType<typeof checkTheme>) =>
      r.pairs.find((p) => p.mode === 'light' && p.role === 'muted')!;
    expect(muted(pass)).toMatchObject({ ratio: 4.54, required: 4.5, passes: true });
    expect(muted(fail)).toMatchObject({ ratio: 4.48, required: 4.5, passes: false });
    expect(fail.issues).toEqual([
      { path: 'palettes.light.muted', message: 'theme.contrast.too-low' },
    ]);
  });
});

describe('checkTheme', () => {
  it('passes the default theme and every preset, with AAA body text reported', () => {
    for (const theme of [DEFAULT_THEME, ...Object.values(THEME_PRESETS)]) {
      const report = checkTheme(theme);
      expect(report).toMatchObject({ valid: true, issues: [] });
      expect(Theme.parse(theme)).toEqual(theme);
      const body = report.pairs.filter((p) => p.role === 'body');
      expect(body.map((p) => p.mode)).toEqual(['light', 'dark']);
      for (const p of body) expect(p.aaa).toBe(true);
    }
  });

  it('reports every pair: six roles, links on body and surface, focus on six backgrounds, per mode', () => {
    const roles = checkTheme(DEFAULT_THEME)
      .pairs.filter((p) => p.mode === 'dark')
      .map((p) => p.role);
    expect(roles).toEqual([
      'body',
      'surface',
      'primary',
      'accent',
      'muted',
      'warning',
      'link-on-body',
      'link-on-surface',
      'focus-on-body',
      'focus-on-surface',
      'focus-on-primary',
      'focus-on-accent',
      'focus-on-muted',
      'focus-on-warning',
    ]);
    const required = checkTheme(DEFAULT_THEME).pairs.map((p) => [
      p.role.split('-on-')[0],
      p.required,
    ]);
    for (const [kind, r] of required) expect(r).toBe(kind === 'focus' ? 3 : 4.5);
  });

  it('checks dark on its own: a failing dark pair is invalid while light is fine', () => {
    const report = checkTheme({
      palettes: { light, dark: { ...dark, link: '#2b2b30' } },
    });
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      { path: 'palettes.dark.link', message: 'theme.contrast.too-low' },
    ]);
    expect(report.pairs.filter((p) => p.mode === 'light').every((p) => p.passes)).toBe(true);
  });

  it('names one issue per failing colour path, also for focus', () => {
    const report = checkTheme(withLight({ focus: '#ffffff' }));
    expect(report.issues).toEqual([
      { path: 'palettes.light.focus', message: 'theme.contrast.too-low' },
    ]);
    expect(
      report.pairs.filter((p) => p.role.startsWith('focus') && !p.passes).length
    ).toBeGreaterThan(1);
  });
});

describe('Theme and ThemeInput', () => {
  it('makes defaults explicit and keeps what was given', () => {
    const resolved = resolveTheme(ThemeInput.parse({ baseSize: 20 }));
    expect(resolved).toEqual({ ...DEFAULT_THEME, baseSize: 20 });
    for (const [k, r] of Object.entries(THEME_RANGES))
      expect(resolveTheme(ThemeInput.parse({}))[k as keyof typeof THEME_RANGES]).toBe(r.default);
  });

  it('accepts the bounds and refuses just outside, NaN, Infinity and strings', () => {
    for (const [k, r] of Object.entries(THEME_RANGES)) {
      expect(ThemeInput.safeParse({ [k]: r.min }).success).toBe(true);
      expect(ThemeInput.safeParse({ [k]: r.max }).success).toBe(true);
      for (const bad of [r.min - 0.001, r.max + 0.001, Number.NaN, Infinity, String(r.default)])
        expect(ThemeInput.safeParse({ [k]: bad }).success, `${k}=${bad}`).toBe(false);
    }
    expect(ThemeInput.safeParse({ headingWeight: 650 }).success).toBe(false);
    expect(ThemeInput.safeParse({ headingWeight: 600 }).success).toBe(true);
  });

  it('accepts only the font catalogue and no CSS, URL or extra key', () => {
    expect(ThemeInput.safeParse({ fontPair: 'source-serif-inter' }).success).toBe(true);
    for (const input of [
      { fontPair: 'Comic Sans' },
      { fontPair: 'https://fonts.example/x.woff2' },
      { css: 'body{}' },
      { fontUrl: 'https://fonts.example/x.woff2' },
      { palettes: { light } },
      { palettes: { light: { ...light, extra: '#000000' }, dark } },
      ...['red', '#fff', '#ffffff80', 'rgb(0,0,0)', 'var(--x)', '#ffffff;}', ' #ffffff'].map((c) =>
        withLight({ link: c })
      ),
    ])
      expect(ThemeInput.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });

  it('uses catalogue keys as messages', () => {
    const r = ThemeInput.safeParse({ ...withLight({ link: 'red' }), baseSize: 99, css: 'x' });
    expect(r.success).toBe(false);
    const messages = r.success ? [] : r.error.issues.map((i) => i.message).sort();
    expect(messages).toEqual([
      'theme.color.invalid',
      'theme.key.unknown',
      'theme.value.out-of-range',
    ]);
  });

  it('refuses contrast failures in Theme but reports them in checkTheme', () => {
    const bad = withLight({ primary: { foreground: '#ffffff', background: '#f2c14e' } });
    expect(ThemeInput.safeParse(bad).success).toBe(true);
    expect(checkTheme(ThemeInput.parse(bad)).valid).toBe(false);
    const parsed = Theme.safeParse(bad);
    expect(parsed.success).toBe(false);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([
      expect.objectContaining({
        path: ['palettes', 'light', 'primary'],
        message: 'theme.contrast.too-low',
      }),
    ]);
  });
});

describe('site.theme.check', () => {
  const invoker = new Invoker(buildRegistry(), new MemoryUnitOfWork());

  it('returns the report for an editor; a shape error is invalid_input', async () => {
    const bad = withLight({ primary: { foreground: '#ffffff', background: '#f2c14e' } });
    const report = await invoker.run(useCases.checkTheme, systemPrincipal(TENANT, 'test'), {
      theme: bad,
    });
    expect(report.valid).toBe(false);
    await expect(
      invoker.run(useCases.checkTheme, systemPrincipal(TENANT, 'test'), {
        theme: { baseSize: 40 },
      })
    ).rejects.toSatisfy((e) => e instanceof UseCaseError && e.code === 'invalid_input');
  });

  it('is editorial: an anonymous principal is refused even with content:read', async () => {
    await expect(
      invoker.run(useCases.checkTheme, anonymousPrincipal(TENANT, ['content:read']), {
        theme: {},
      })
    ).rejects.toBeInstanceOf(UseCaseError);
  });
});
