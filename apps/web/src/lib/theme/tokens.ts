// A theme's values as CSS custom properties (ADR 013 rule 1, brief #8c § 3): the one place a
// `ResolvedTheme` becomes CSS. `base.css` reads only these properties, so a tenant's theme changes
// the look without a line of tenant CSS. Every number is formatted here from a validated range and
// every colour is a validated `#RRGGBB`, so the output has a closed grammar the conformance suite
// checks over random themes.
//
// Served as a stylesheet route with the content hash in its path (`/_theme/<hash>.css`,
// immutable), not as `<style nonce>`: components have no nonce, and a stylesheet is cacheable
// across pages. Both palettes are explicit (light in `:root`, dark under `prefers-color-scheme`),
// never derived. The `@font-face` rules are here too, because the font pair is a theme value and
// `inter` must not load Source Serif.
//
// Rejected: CSS built by string concatenation in a component, and colour arithmetic for hover or
// dark states (a computed colour nobody checked for contrast).

import { THEME_ROLES, type FontPair, type Palette, type ResolvedTheme } from '@mycel/core';

/** Self-hosted, Latin-subset variable fonts in `static/fonts` (docs/reference/fonts.md). */
export const FONT_FILES = {
  inter: {
    roman: '/fonts/inter/inter-latin-roman.woff2',
    italic: '/fonts/inter/inter-latin-italic.woff2',
  },
  sourceSerif: {
    roman: '/fonts/source-serif-4/source-serif-4-latin-roman.woff2',
    italic: '/fonts/source-serif-4/source-serif-4-latin-italic.woff2',
  },
} as const;

const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

const SANS_FALLBACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";

/** The two roman files to preload for a pair: the faces the first paint needs. */
export function preloadFonts(pair: FontPair): string[] {
  return pair === 'inter'
    ? [FONT_FILES.inter.roman]
    : [FONT_FILES.sourceSerif.roman, FONT_FILES.inter.roman];
}

function fontFaces(pair: FontPair): string {
  const face = (family: string, file: string, style: string, weight: string) =>
    `@font-face { font-family: '${family}'; src: url('${file}') format('woff2'); font-style: ${style}; font-weight: ${weight}; font-display: swap; unicode-range: ${LATIN}; }`;
  const faces = [
    face('Inter', FONT_FILES.inter.roman, 'normal', '100 900'),
    face('Inter', FONT_FILES.inter.italic, 'italic', '100 900'),
  ];
  if (pair === 'source-serif-inter')
    faces.push(
      face('Mycel Serif', FONT_FILES.sourceSerif.roman, 'normal', '200 900'),
      face('Mycel Serif', FONT_FILES.sourceSerif.italic, 'italic', '200 900')
    );
  return faces.join('\n');
}

/** Rounded to four decimals and without trailing zeros: `1.25`, `0.9`, never `NaN` or `1e-7`. */
const num = (n: number): string => {
  if (!Number.isFinite(n)) throw new RangeError(`not a finite number: ${n}`);
  return String(Math.round(n * 10_000) / 10_000);
};

function palette(p: Palette): string[] {
  const lines = THEME_ROLES.flatMap((role) => [
    `--color-${role}-fg: ${p[role].foreground};`,
    `--color-${role}-bg: ${p[role].background};`,
  ]);
  lines.push(`--color-link: ${p.link};`, `--color-focus: ${p.focus};`);
  return lines;
}

/** Steps below and above the base size, from `baseSize * scaleRatio^n`, in rem of 16 px. */
export const STEPS = [-1, 0, 1, 2, 3, 4] as const;
const stepName = (n: number) => (n < 0 ? `--step--${-n}` : `--step-${n}`);

export function themeCss(theme: ResolvedTheme): string {
  const sizes = STEPS.map(
    (n) => `${stepName(n)}: ${num((theme.baseSize * theme.scaleRatio ** n) / 16)}rem;`
  );
  // Body text is Inter in both pairs; the pair only chooses the headings.
  const heading =
    theme.fontPair === 'inter' ? `Inter, ${SANS_FALLBACK}` : `'Mycel Serif', ${SERIF_FALLBACK}`;
  const root = [
    ...palette(theme.palettes.light),
    `--font-body: Inter, ${SANS_FALLBACK};`,
    `--font-heading: ${heading};`,
    `--heading-weight: ${theme.headingWeight};`,
    ...sizes,
    `--measure: ${num(theme.measure)}ch;`,
    `--radius: ${num(theme.radius / 16)}rem;`,
    `--density: ${num(theme.density)};`,
    'color-scheme: light dark;',
  ];
  const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`).join('\n');
  return [
    fontFaces(theme.fontPair),
    `:root {\n${indent(root, '  ')}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${indent(palette(theme.palettes.dark), '    ')}\n  }\n}`,
    '',
  ].join('\n');
}

/** A short content hash for the stylesheet path; a changed theme is a new URL. */
export async function themeHash(css: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(css));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
