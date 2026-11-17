// The caption face is the one theme value that adds a property only when chosen: `body` must keep
// every existing stylesheet byte-identical (and so its hash and URL), `mono` adds exactly one line.
// Rejected: asserting through the token grammar below alone, which never renders a mono theme
// because no preset chooses one. That grammar (`theme tokens`) holds the stylesheet complete,
// finite and inside its own properties for the presets and for random valid themes; it stood in
// the block conformance suite until that suite reached its size ceiling.
import {
  DEFAULT_THEME,
  THEME_PRESETS,
  THEME_RANGES,
  THEME_ROLES,
  Theme,
  contrastRatio,
  resolveTheme,
  type ResolvedTheme,
} from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { CAPTION_MONO, STEPS, themeCss, themeHash } from './tokens.js';

const themes: ResolvedTheme[] = [DEFAULT_THEME, ...Object.values(THEME_PRESETS)];

describe('caption font tokens', () => {
  it('sets no caption face for body, nor for a theme stored before the choice', async () => {
    for (const theme of themes) {
      const body = themeCss({ ...theme, captionFont: 'body' });
      const { captionFont: _, ...stored } = theme;
      const before = themeCss(stored as ResolvedTheme);
      expect(body).not.toContain('--font-caption');
      expect(body).toBe(before);
      expect(await themeHash(body)).toBe(await themeHash(before));
    }
  });

  it('sets the system monospace once, in :root and not per colour scheme, for mono', () => {
    for (const theme of themes) {
      const body = themeCss(theme);
      const mono = themeCss({ ...theme, captionFont: 'mono' });
      const line = `--font-caption: ${CAPTION_MONO};`;
      expect(mono.split(line)).toHaveLength(2);
      expect(mono.indexOf(line)).toBeLessThan(mono.indexOf('@media (prefers-color-scheme: dark)'));
      expect(mono.replace(`  ${line}\n`, '')).toBe(body);
      expect(CAPTION_MONO).toBe('ui-monospace, SFMono-Regular, Menlo, Consolas, monospace');
    }
  });
});

describe('theme tokens', () => {
  const PROPERTIES = [
    ...THEME_ROLES.flatMap((r) => [`--color-${r}-fg`, `--color-${r}-bg`]),
    ...['primary', 'accent', 'body'].flatMap((r) => [
      `--color-${r}-active-fg`,
      `--color-${r}-active-bg`,
    ]),
    '--color-caption-fg',
    '--color-link',
    '--color-focus',
    '--font-body',
    '--font-heading',
    '--heading-weight',
    ...STEPS.map((n) => (n < 0 ? `--step--${-n}` : `--step-${n}`)),
    '--measure',
    '--radius',
    '--density',
    ...[1, 2, 3, 4].flatMap((k) =>
      ['fg', 'bg', 'bar', 'active-fg', 'active-bg'].map((t) => `--card-${k}-${t}`)
    ),
  ];
  it('keeps a caption readable on the page, lighter than muted text where there is room', () => {
    for (const theme of Object.values(THEME_PRESETS)) {
      const css = themeCss(resolveTheme({ ...theme }));
      const [, caption] = /--color-caption-fg: (#[a-f0-9]{6});/i.exec(css)!;
      const [, muted] = /--color-muted-fg: (#[a-f0-9]{6});/i.exec(css)!;
      const [, page] = /--color-body-bg: (#[a-f0-9]{6});/i.exec(css)!;
      expect(contrastRatio(caption!, page!)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(caption!, page!)).toBeLessThanOrEqual(contrastRatio(muted!, page!));
    }
  });

  // The grammar of the output: declarations of our own properties with hex colours, plain
  // numbers with a unit, our font names and the @font-face rules of our own files.
  const declaration =
    /^--[a-z0-9-]+: (#[0-9a-f]{6}|-?\d+(\.\d+)?(rem|ch)?|Inter, system-ui, -apple-system, 'Segoe UI', sans-serif|'Mycel Serif', Georgia, 'Times New Roman', serif);$/i;

  function problems(theme: ResolvedTheme): string[] {
    const css = themeCss(theme);
    const out: string[] = [];
    if (/NaN|Infinity|undefined|e[+-]\d/.test(css)) out.push('non-finite or exponent number');
    for (const p of PROPERTIES) if (!css.includes(`${p}:`)) out.push(`missing ${p}`);
    for (const line of css.split('\n').map((l) => l.trim())) {
      if (!line || line === '}' || line === ':root {' || line === 'color-scheme: light dark;')
        continue;
      if (line === '@media (prefers-color-scheme: dark) {') continue;
      if (line.startsWith("@font-face { font-family: '") && line.includes("src: url('/fonts/"))
        continue;
      if (!declaration.test(line)) out.push(`outside the grammar: ${line}`);
    }
    return out;
  }

  it('maps the default theme and every preset completely', () => {
    for (const theme of [DEFAULT_THEME, ...Object.values(THEME_PRESETS)])
      expect(problems(theme as ResolvedTheme)).toEqual([]);
  });

  it('keeps interactive tokens readable even for a pair just above the contrast floor', () => {
    const boundary = structuredClone(DEFAULT_THEME);
    boundary.palettes.light.primary = { foreground: '#767676', background: '#ffffff' };
    for (const theme of [DEFAULT_THEME, ...Object.values(THEME_PRESETS), boundary]) {
      const css = themeCss(theme);
      const palettes = css.split(':root {').slice(1);
      for (const [index, mode] of (['light', 'dark'] as const).entries())
        for (const role of ['primary', 'accent', 'body'] as const) {
          const token = (suffix: string) =>
            new RegExp(`--color-${role}-${suffix}: (#[a-f0-9]{6});`, 'i').exec(
              palettes[index]!
            )![1]!;
          const pair = theme.palettes[mode][role];
          const fg = token('active-fg');
          const bg = token('active-bg');
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
          // Active feedback is a real colour change, never a foreground/background inversion.
          expect([fg, bg]).not.toEqual([pair.foreground, pair.background]);
          expect([fg, bg]).not.toEqual([pair.background, pair.foreground]);
        }
    }
  });

  // The action row: four card positions take the theme's accent walk round; without one a filled card is
  // primary and a bar accent, as before. The button on a filled card is its pair inverted, and its
  // active pair stays readable.
  it('walks the card accents over four positions, with a readable inverted button', () => {
    const slot = (css: string, k: number, t: string) =>
      new RegExp(`--card-${k}-${t}: (#[a-f0-9]{6});`, 'i').exec(css)![1]!;
    const plain = themeCss(DEFAULT_THEME);
    const { primary, accent } = DEFAULT_THEME.palettes.light;
    for (const k of [1, 2, 3, 4]) {
      expect(slot(plain, k, 'bg')).toBe(primary.background);
      expect(slot(plain, k, 'bar')).toBe(accent.background);
    }
    const walk = [
      { foreground: '#ffffff', background: '#d32f2f' },
      { foreground: '#ffffff', background: '#2e7d32' },
      { foreground: '#1b1b1f', background: '#f2c14e' },
    ];
    const theme = structuredClone(DEFAULT_THEME);
    theme.palettes.light.cardAccents = walk;
    const css = themeCss(theme);
    expect([1, 2, 3, 4].map((k) => slot(css, k, 'bg'))).toEqual(
      [0, 1, 2, 0].map((i) => walk[i]!.background)
    );
    expect([1, 2, 3, 4].map((k) => slot(css, k, 'bar'))).toEqual(
      [0, 1, 2, 0].map((i) => walk[i]!.background)
    );
    expect(problems(theme)).toEqual([]);
    for (const k of [1, 2, 3, 4])
      expect(
        contrastRatio(slot(css, k, 'active-fg'), slot(css, k, 'active-bg'))
      ).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps active feedback for arbitrary readable colour pairs', () => {
    let seed = 131;
    const colour = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return '#' + (seed & 0xffffff).toString(16).padStart(6, '0');
    };
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      const foreground = colour(),
        background = colour();
      if (contrastRatio(foreground, background) < 4.5) continue;
      const theme = structuredClone(DEFAULT_THEME);
      theme.palettes.light.primary = { foreground, background };
      const css = themeCss(theme);
      const fg = /--color-primary-active-fg: (#[a-f0-9]{6});/i.exec(css)![1]!;
      const bg = /--color-primary-active-bg: (#[a-f0-9]{6});/i.exec(css)![1]!;
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      expect([fg, bg]).not.toEqual([foreground, background]);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('loads Source Serif only for the serif pair, and both palettes explicitly', () => {
    expect(themeCss(DEFAULT_THEME)).not.toContain('Mycel Serif');
    const editorial = themeCss(THEME_PRESETS.editorial as ResolvedTheme);
    expect(editorial).toContain("font-family: 'Mycel Serif'");
    expect(editorial).toContain(`--color-link: ${THEME_PRESETS.editorial.palettes.dark.link};`);
  });

  it('stays inside the grammar for random valid themes', () => {
    // A seeded generator: reproducible, and every value inside the validated ranges.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const between = (min: number, max: number) => min + random() * (max - min);
    for (let i = 0; i < 200; i += 1) {
      const theme: ResolvedTheme = {
        ...DEFAULT_THEME,
        fontPair: random() < 0.5 ? 'inter' : 'source-serif-inter',
        baseSize: between(THEME_RANGES.baseSize.min, THEME_RANGES.baseSize.max),
        scaleRatio: between(THEME_RANGES.scaleRatio.min, THEME_RANGES.scaleRatio.max),
        measure: between(THEME_RANGES.measure.min, THEME_RANGES.measure.max),
        radius: between(THEME_RANGES.radius.min, THEME_RANGES.radius.max),
        density: between(THEME_RANGES.density.min, THEME_RANGES.density.max),
        headingWeight: ([400, 500, 600, 700, 800] as const)[Math.floor(random() * 5)]!,
      };
      // The same values a write would accept (contrast is unchanged from the default).
      expect(Theme.safeParse(theme).success).toBe(true);
      expect(problems(theme)).toEqual([]);
    }
  });
});
