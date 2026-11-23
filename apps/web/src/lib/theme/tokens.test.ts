// The caption face is the one theme value that adds a property only when chosen: `body` must keep
// every existing stylesheet byte-identical (and so its hash and URL), `mono` adds exactly one line.
// Rejected: asserting through the token grammar below alone, which never renders a mono theme
// because no preset chooses one. That grammar (`theme tokens`) holds the stylesheet complete,
// finite and inside its own properties for the presets and for random valid themes; it stood in
// the block conformance suite until that suite reached its size ceiling.
import { existsSync, readFileSync } from 'node:fs';
import {
  CHROME_ROLES,
  DEFAULT_THEME,
  FONTS,
  FONT_KEYS,
  hasWeight,
  THEME_PRESETS,
  THEME_RANGES,
  THEME_ROLES,
  Theme,
  contrastRatio,
  focusHalo,
  resolveTheme,
  type ResolvedTheme,
} from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { fontFaces, specimenCss } from './font-files.js';
import {
  CAPTION_MONO,
  preloadFonts,
  STEPS,
  themeCss,
  themeHash,
  withItalicPreload,
} from './tokens.js';

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

// MY-283: capitals are two tokens the base styles read for headings and buttons; `normal`, and
// a theme stored before the choice, render byte for byte as before.
describe('heading case tokens', () => {
  it('adds the case and its tracking for upper only', async () => {
    for (const theme of themes) {
      const { headingCase: _, ...stored } = theme;
      const normal = themeCss({ ...theme, headingCase: 'normal' });
      expect(normal).not.toContain('--heading-case');
      expect(normal).toBe(themeCss(stored as ResolvedTheme));
      const upper = themeCss({ ...theme, headingCase: 'upper' });
      expect(upper).toContain('--heading-case: uppercase;');
      expect(upper).toContain('--heading-tracking: 0.04em;');
      expect(await themeHash(upper)).not.toBe(await themeHash(normal));
    }
  });
});

// MY-266: the site's chrome only uses pairs the theme check already measured. Over random valid
// themes, in both palettes, the header and footer are copies of their chosen role pair and the
// header's call to action is the primary pair, inverted on a primary header; its active pair
// stays readable. Random primary and accent pairs, so a pair just above the floor is covered.
describe('chrome tokens', () => {
  const token = (block: string, name: string) =>
    new RegExp(`--chrome-${name}: (#[a-f0-9]{6});`, 'i').exec(block)![1]!;
  const pairOf = (block: string, part: string) => ({
    foreground: token(block, `${part}-fg`),
    background: token(block, `${part}-bg`),
  });

  it('copies the chosen role pairs and inverts the primary action only on a primary header', () => {
    let seed = 266;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
    const colour = () => '#' + (next() & 0xffffff).toString(16).padStart(6, '0');
    const pick = () => CHROME_ROLES[next() % CHROME_ROLES.length]!;
    const readable = () => {
      for (;;) {
        const pair = { foreground: colour(), background: colour() };
        if (contrastRatio(pair.foreground, pair.background) >= 4.5) return pair;
      }
    };
    let checked = 0;
    // Stop at 300 accepted themes: with the halo (MY-272) far more random themes pass the check,
    // and each one renders a full stylesheet.
    for (let i = 0; i < 3000 && checked < 300; i++) {
      const theme = structuredClone(DEFAULT_THEME);
      for (const mode of ['light', 'dark'] as const) {
        theme.palettes[mode].primary = readable();
        theme.palettes[mode].accent = readable();
      }
      theme.chrome = { header: pick(), footer: pick() };
      // Only what a write accepts: a focus band must also hold on the random backgrounds.
      if (!Theme.safeParse(theme).success) continue;
      const blocks = themeCss(theme).split(':root {').slice(1);
      for (const [index, mode] of (['light', 'dark'] as const).entries()) {
        const p = theme.palettes[mode];
        const block = blocks[index]!;
        const header = pairOf(block, 'header');
        const footer = pairOf(block, 'footer');
        expect(header).toEqual(p[theme.chrome.header]);
        expect(footer).toEqual(p[theme.chrome.footer]);
        // One of the two focus bands, ring or halo, holds on the header and the footer (MY-272).
        for (const pair of [header, footer])
          expect(
            Math.max(
              contrastRatio(p.focus, pair.background),
              contrastRatio(focusHalo(p), pair.background)
            )
          ).toBeGreaterThanOrEqual(3);
        const action = pairOf(block, 'action');
        expect(action).toEqual(
          theme.chrome.header === 'primary'
            ? { foreground: p.primary.background, background: p.primary.foreground }
            : p.primary
        );
        expect(action.background).not.toBe(header.background);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('theme tokens', () => {
  const PROPERTIES = [
    ...THEME_ROLES.flatMap((r) => [`--color-${r}-fg`, `--color-${r}-bg`]),
    '--color-primary-active-fg',
    '--color-primary-active-bg',
    '--color-caption-fg',
    '--color-link',
    '--color-focus',
    '--color-focus-halo',
    '--font-body',
    '--font-heading',
    '--heading-weight',
    ...STEPS.map((n) => (n < 0 ? `--step--${-n}` : `--step-${n}`)),
    '--measure',
    '--radius',
    '--density',
    ...[1, 2, 3, 4].flatMap((k) => ['fg', 'bg', 'bar'].map((t) => `--card-${k}-${t}`)),
    ...['header', 'footer', 'action'].flatMap((part) => [
      `--chrome-${part}-fg`,
      `--chrome-${part}-bg`,
    ]),
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
  const family = FONT_KEYS.map((k) => FONTS[k].family).join('|');
  const declaration = new RegExp(
    `^--[a-z0-9-]+: (#[0-9a-f]{6}|-?\\d+(\\.\\d+)?(rem|ch)?|'(${family})', (system-ui, -apple-system, 'Segoe UI', sans-serif|Georgia, 'Times New Roman', serif));$`,
    'i'
  );

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
        for (const role of ['primary'] as const) {
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
  // primary and a bar accent, as before. The button on a filled card is its pair inverted
  // (action-row.css), so its contrast is the card's.
  it('walks the card accents over four positions', () => {
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

  it('declares only the two chosen families, each file of the catalogue on disk', () => {
    for (const heading of FONT_KEYS)
      for (const body of FONT_KEYS) {
        const css = themeCss({ ...DEFAULT_THEME, headingFont: heading, bodyFont: body });
        const declared = new Set(
          [...css.matchAll(/@font-face \{ font-family: '([^']+)'/g)].map((m) => m[1])
        );
        expect(declared).toEqual(new Set([FONTS[heading].family, FONTS[body].family]));
      }
    for (const key of FONT_KEYS)
      for (const face of fontFaces(key))
        expect(existsSync(new URL(`../../../static${face.file}`, import.meta.url)), face.file).toBe(
          true
        );
  });

  // The admin's font picker (MY-261 PR 2) serves the generated stylesheet as a static file.
  it('keeps the font picker stylesheet equal to its generator, a face and a rule per font', () => {
    const file = new URL('../../../static/_admin/font-specimens.css', import.meta.url);
    const css = specimenCss();
    expect(readFileSync(file, 'utf8'), 'regenerate static/_admin/font-specimens.css').toBe(css);
    for (const key of FONT_KEYS) {
      expect(css).toContain(
        `.ui-font-specimen[data-font='${key}'] { font-family: '${FONTS[key].family}'`
      );
      expect(css).toContain(`@font-face { font-family: '${FONTS[key].family}';`);
    }
    expect(css).not.toContain('italic');
  });

  it('preloads the body regular first, then the heading at its weight, and its italic only', () => {
    const theme = { ...DEFAULT_THEME, bodyFont: 'poppins', headingFont: 'vesper-libre' } as const;
    expect(preloadFonts({ ...theme, headingWeight: 700 })).toEqual([
      '/fonts/poppins/poppins-latin-400.woff2',
      '/fonts/vesper-libre/vesper-libre-latin-700.woff2',
    ]);
    expect(preloadFonts({ ...DEFAULT_THEME, headingWeight: 800 })).toEqual([
      '/fonts/inter/inter-latin-roman.woff2',
    ]);
    const page = (fonts: string[], body: string) =>
      `<head>${fonts.map((f) => `<link rel="preload" href="${f}" as="font">`).join('')}</head><body>${body}</body>`;
    const poppins = withItalicPreload(
      page(preloadFonts({ ...theme, headingWeight: 700 }), '<em>x</em>')
    );
    expect(poppins).toContain('href="/fonts/poppins/poppins-latin-400-italic.woff2"');
    expect(poppins).not.toContain('vesper-libre-latin-400');
    const quicksand = page(preloadFonts({ ...DEFAULT_THEME, bodyFont: 'quicksand' }), '<em>x</em>');
    expect(withItalicPreload(quicksand)).toBe(quicksand);
  });

  it('stays inside the grammar for random valid themes', () => {
    // A seeded generator: reproducible, and every value inside the validated ranges.
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const between = (min: number, max: number) => min + random() * (max - min);
    for (let i = 0; i < 200; i += 1) {
      const theme: ResolvedTheme = {
        ...DEFAULT_THEME,
        headingFont: FONT_KEYS[Math.floor(random() * FONT_KEYS.length)]!,
        bodyFont: FONT_KEYS[Math.floor(random() * FONT_KEYS.length)]!,
        baseSize: between(THEME_RANGES.baseSize.min, THEME_RANGES.baseSize.max),
        scaleRatio: between(THEME_RANGES.scaleRatio.min, THEME_RANGES.scaleRatio.max),
        measure: between(THEME_RANGES.measure.min, THEME_RANGES.measure.max),
        radius: between(THEME_RANGES.radius.min, THEME_RANGES.radius.max),
        density: between(THEME_RANGES.density.min, THEME_RANGES.density.max),
        headingWeight: ([400, 500, 600, 700, 800] as const)[Math.floor(random() * 5)]!,
      };
      // A static heading font only has some weights; the write refuses the rest.
      if (!hasWeight(theme.headingFont, theme.headingWeight)) theme.headingWeight = 700;
      // The same values a write would accept (contrast is unchanged from the default).
      expect(Theme.safeParse(theme).success).toBe(true);
      expect(problems(theme)).toEqual([]);
    }
  });
});
