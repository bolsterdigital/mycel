// Theme invariants (ADR 013 rule 1, TODO #8b2): the WCAG arithmetic against known values and the
// 4.5:1 boundary, light and dark checked apart, one check behind `site.theme.check` and `Theme`, every
// preset valid, defaults explicit, and no shape that could smuggle CSS or a URL in.

import { describe, expect, it } from 'vitest';
import { UseCaseError } from '../errors.js';
import { Invoker } from '../invoke.js';
import { anonymousPrincipal, systemPrincipal } from '../principal.js';
import { MemoryUnitOfWork, TENANT } from '../testing/index.js';
import { buildRegistry, useCases } from '../use-cases.js';
import { Theme, checkTheme, contrastRatio, focusHalo, resolveTheme } from './contrast.js';
import { THEME_RANGES, THEME_VERSION, ThemeInput, type Palette } from './model.js';
import { DEFAULT_THEME, THEME_PRESETS } from './presets.js';
import { FONTS, FONT_KEYS, hasWeight } from './fonts.js';

const light = DEFAULT_THEME.palettes.light;
const dark = DEFAULT_THEME.palettes.dark;
const withLight = (patch: Partial<Palette>): ThemeInput => ({
  version: THEME_VERSION,
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
      version: THEME_VERSION,
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
    // On the page the ring itself counts, never the halo (MY-272).
    expect(
      report.pairs.filter((p) => p.role.startsWith('focus') && !p.passes).map((p) => p.role)
    ).toContain('focus-on-body');
  });

  // MY-272: a dark footer beside a light brand colour. One focus colour cannot reach 3:1 on both;
  // the halo, the body colour furthest from the ring, carries the background the ring misses.
  it('lets the halo carry a role background the ring misses, never the page', () => {
    const brown = { foreground: '#ffffff', background: '#3b3228' };
    const light = {
      ...DEFAULT_THEME.palettes.light,
      body: { foreground: '#1e293b', background: '#f8f8f8' },
      primary: { foreground: '#1e293b', background: '#8dd3f6' },
      muted: brown,
      focus: '#102c4c',
    };
    expect(focusHalo(light)).toBe('#f8f8f8');
    const report = checkTheme({ ...DEFAULT_THEME, palettes: { ...DEFAULT_THEME.palettes, light } });
    const muted = report.pairs.find((p) => p.mode === 'light' && p.role === 'focus-on-muted')!;
    expect(contrastRatio('#102c4c', brown.background)).toBeLessThan(3);
    expect(muted).toMatchObject({ passes: true, required: 3 });
    expect(muted.ratio).toBeCloseTo(contrastRatio('#f8f8f8', brown.background), 2);
    expect(report.issues.filter((i) => i.path.endsWith('.focus'))).toEqual([]);
    // A mid-tone where neither band reaches 3:1 still fails, at the focus path.
    const grey = { foreground: '#000000', background: '#a0a0a0' };
    const both = checkTheme({
      ...DEFAULT_THEME,
      palettes: {
        ...DEFAULT_THEME.palettes,
        light: {
          ...light,
          muted: grey,
          focus: '#5a5a5a',
          body: { foreground: '#000000', background: '#ffffff' },
        },
      },
    });
    expect(contrastRatio('#5a5a5a', '#ffffff')).toBeGreaterThan(3);
    expect(both.issues).toContainEqual({
      path: 'palettes.light.focus',
      message: 'theme.contrast.too-low',
    });
  });
});

describe('card accents of the action row', () => {
  const red = { foreground: '#ffffff', background: '#d32f2f' };
  const green = { foreground: '#ffffff', background: '#2e7d32' };

  it('checks each accent as text on its card and the focus on it, at its own path', () => {
    const report = checkTheme(withLight({ cardAccents: [red, green] }));
    expect(report.valid).toBe(true);
    expect(report.pairs.filter((p) => p.mode === 'light').map((p) => p.role)).toEqual(
      expect.arrayContaining([
        'cardAccents.0',
        'focus-on-cardAccents.0',
        'cardAccents.1',
        'focus-on-cardAccents.1',
      ])
    );
    const pale = { foreground: '#ffffff', background: '#f2c14e' };
    const bad = Theme.safeParse(withLight({ cardAccents: [red, pale] }));
    expect(bad.success ? [] : bad.error.issues).toEqual([
      expect.objectContaining({
        path: ['palettes', 'light', 'cardAccents', '1'],
        message: 'theme.contrast.too-low',
      }),
    ]);
  });

  it('takes one to four accents, and a theme without them stays valid as it was', () => {
    for (const n of [1, 4])
      expect(Theme.safeParse(withLight({ cardAccents: Array(n).fill(red) })).success).toBe(true);
    for (const accents of [[], Array(5).fill(red), [{ ...red, css: 'x' }], [{ foreground: 'red' }]])
      expect(ThemeInput.safeParse(withLight({ cardAccents: accents as never })).success).toBe(
        false
      );
    expect(Theme.parse(DEFAULT_THEME).palettes.light.cardAccents).toBeUndefined();
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
    expect(ThemeInput.safeParse({ headingFont: 'rubik', bodyFont: 'open-sans' }).success).toBe(
      true
    );
    for (const input of [
      { headingFont: 'Comic Sans' },
      { bodyFont: 'https://fonts.example/x.woff2' },
      { headingFont: 'Rubik' },
      { fontPair: 'inter' },
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

  it('gives every catalogue font a regular and a bold face, so each can set body text', () => {
    for (const key of FONT_KEYS) {
      expect(hasWeight(key, 400), key).toBe(true);
      expect(hasWeight(key, 700), key).toBe(true);
    }
    expect(new Set(FONT_KEYS.map((k) => FONTS[k].family)).size).toBe(FONT_KEYS.length);
  });

  it('refuses a heading weight the heading font has no face for, in the report and the write', () => {
    const input = { headingFont: 'vesper-libre', headingWeight: 600 } as const;
    expect(ThemeInput.safeParse(input).success).toBe(true);
    expect(checkTheme(ThemeInput.parse(input)).issues).toEqual([
      { path: 'headingWeight', message: 'theme.font.weight-unavailable' },
    ]);
    const r = Theme.safeParse({ ...DEFAULT_THEME, ...input });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
      'theme.font.weight-unavailable',
    ]);
    expect(Theme.parse({ ...DEFAULT_THEME, ...input, headingWeight: 700 }).headingFont).toBe(
      'vesper-libre'
    );
    expect(checkTheme(ThemeInput.parse({ headingFont: 'rubik', headingWeight: 800 })).valid).toBe(
      true
    );
  });

  it('sets captions in body by default, takes mono and refuses any other face', () => {
    expect(resolveTheme(ThemeInput.parse({})).captionFont).toBe('body');
    expect(resolveTheme(ThemeInput.parse({ captionFont: 'mono' })).captionFont).toBe('mono');
    expect(Theme.parse({ ...DEFAULT_THEME, captionFont: 'mono' }).captionFont).toBe('mono');
    for (const captionFont of ['serif', 'Courier New', 'monospace', '', null, 1]) {
      const r = ThemeInput.safeParse({ captionFont });
      expect(r.success, String(captionFont)).toBe(false);
      expect(r.success ? [] : r.error.issues.map((i) => i.message)).toEqual([
        'theme.value.not-allowed',
      ]);
    }
  });

  // MY-266: header and footer stand in a role pair each; a theme stored before the choice is
  // read through `Theme` like any other and gets the default, as an absent `captionFont` does.
  it('puts header and footer in primary by default and each in one chrome role only', () => {
    expect(resolveTheme(ThemeInput.parse({})).chrome).toEqual({
      header: 'primary',
      footer: 'primary',
    });
    expect(resolveTheme(ThemeInput.parse({ chrome: { header: 'surface' } })).chrome).toEqual({
      header: 'surface',
      footer: 'primary',
    });
    const { chrome: _, ...stored } = DEFAULT_THEME;
    expect(Theme.parse(stored).chrome).toEqual(DEFAULT_THEME.chrome);
    expect(
      Theme.parse({ ...DEFAULT_THEME, chrome: { header: 'body', footer: 'accent' } }).chrome
    ).toEqual({ header: 'body', footer: 'accent' });
    for (const role of ['muted', 'warning', 'link', '#2d6cb5', '', null])
      for (const part of ['header', 'footer']) {
        const r = ThemeInput.safeParse({ chrome: { [part]: role } });
        expect(r.success ? [] : r.error.issues.map((i) => i.message), `${part}: ${role}`).toEqual([
          'theme.value.not-allowed',
        ]);
      }
    const extra = ThemeInput.safeParse({ chrome: { header: 'primary', drawer: 'primary' } });
    expect(extra.success ? [] : extra.error.issues.map((i) => i.message)).toEqual([
      'theme.key.unknown',
    ]);
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
