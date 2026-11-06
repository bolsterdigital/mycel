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
// Rejected: component-local CSS and unchecked hover arithmetic. Interaction pairs keep the
// original polarity and are checked along the entire sRGB transition before becoming tokens.

import {
  contrastRatio,
  luminance,
  THEME_ROLES,
  type FontPair,
  type Palette,
  type ResolvedTheme,
} from '@mycel/core';

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

// Elements a browser renders italic by default; no stylesheet here sets `font-style` itself.
const ITALIC_ELEMENT = /<(?:em|i|cite|dfn|var|address)[\s>]/;
const ROMAN_PRELOAD = new RegExp(
  `<link rel="preload" href="${FONT_FILES.inter.roman}"[^>]*>`.replaceAll('/', '\\/')
);

/**
 * The italic Inter face as a low-priority preload, after the roman one, on a rendered page whose
 * body uses italic text. Discovered during layout instead, the font is fetched at the highest
 * priority, which Lighthouse counts as render-blocking although `font-display: swap` lets text
 * paint before it arrives: 116 KB on the first paint's critical path. Low priority keeps it off
 * that path and out of the LCP image's way. Pages without italic text never fetch it. Only the
 * body face: headings and pull quotes are plain text and never italic.
 * Rejected: preloading the italic face on every page (wasted bytes on most of them), and listing
 * the italic-emitting components (a new one would silently bring the cost back).
 */
export function withItalicPreload(html: string): string {
  const roman = ROMAN_PRELOAD.exec(html);
  if (!roman) return html;
  const body = html.indexOf('<body');
  if (body < 0 || !ITALIC_ELEMENT.test(html.slice(body))) return html;
  const italic = `<link rel="preload" href="${FONT_FILES.inter.italic}" as="font" type="font/woff2" crossorigin="anonymous" fetchpriority="low">`;
  const end = roman.index + roman[0].length;
  return html.slice(0, end) + italic + html.slice(end);
}

function fontFaces(pair: FontPair): string {
  const face = (family: string, file: string, style: string, weight: string) =>
    `@font-face { font-family: '${family}'; src: url('${file}') format('woff2'); font-style: ${style}; font-weight: ${weight}; font-display: swap; unicode-range: ${LATIN}; }`;
  const faces = [
    face('Inter', FONT_FILES.inter.roman, 'normal', '100 900'),
    // The italic file is instanced to 400-700 at text size (docs/reference/fonts.md).
    face('Inter', FONT_FILES.inter.italic, 'italic', '400 700'),
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

/** The colour a fraction of the way from `a` to `b` in sRGB, rounded. */
const mix = (a: string, b: string, fraction: number) =>
  '#' +
  [1, 3, 5]
    .map((i) =>
      Math.round(
        parseInt(a.slice(i, i + 2), 16) * (1 - fraction) +
          parseInt(b.slice(i, i + 2), 16) * fraction
      )
        .toString(16)
        .padStart(2, '0')
    )
    .join('');

// Keep a role's character, rather than fading through an unreadable foreground/background
// inversion. Try a mild softening first, then strengthen the pair when it has no spare contrast.
// Check the sRGB path including rounding; browser fixtures also measure actual interpolated colours.
function interactionPair(pair: Palette['primary']): Palette['primary'] {
  const { foreground: fg, background: bg } = pair;
  const lightText = luminance(fg) > luminance(bg);
  const strongFg = mix(fg, lightText ? '#ffffff' : '#000000', 0.12);
  const strongBg = mix(bg, lightText ? '#000000' : '#ffffff', 0.12);
  const candidates = [
    { foreground: mix(fg, bg, 0.04), background: mix(bg, fg, 0.08) },
    { foreground: mix(fg, bg, 0.02), background: strongBg },
    { foreground: strongFg, background: mix(bg, fg, 0.02) },
    { foreground: strongFg, background: strongBg },
  ];
  return (
    candidates.find((target) =>
      Array.from({ length: 101 }, (_, i) => i / 100).every(
        (t) => contrastRatio(mix(fg, target.foreground, t), mix(bg, target.background, t)) >= 4.5
      )
    ) ?? pair
  );
}

/**
 * A photo caption is quieter than other muted text (P185-79): the muted colour moved towards the
 * page as far as a caption stays readable, at most a quarter of the way. A theme whose muted text
 * has no contrast to spare keeps it. Here and not with `color-mix` in the stylesheet, which
 * cannot know the result's contrast.
 */
function captionForeground(p: Palette): string {
  const { foreground } = p.muted;
  const { background } = p.body;
  const step = Array.from({ length: 26 }, (_, i) => (25 - i) / 100).find(
    (t) => contrastRatio(mix(foreground, background, t), background) >= 4.6
  );
  return step ? mix(foreground, background, step) : foreground;
}

/**
 * The colours of an action row, per card position: a row has at most four cards, so four
 * slots, each the theme's accent walk taken round (`k mod n`), and `action-row.css` maps
 * `:nth-child(k)` onto slot k. Without accents a bar is `accent` and a filled card `primary`, as
 * before. The button on a filled card is the card's pair inverted, so its contrast is the card's;
 * the `accent` button it replaced reached 1.1 to 1.5 : 1 on a light card in dark mode. Rejected: a
 * `--cycle-n` class from the renderer (the block would have to know the theme) and computing the
 * walk with `color-mix` (no contrast check can see it).
 */
function cardSlots(p: Palette): string[] {
  const accents = p.cardAccents;
  return [1, 2, 3, 4].flatMap((k) => {
    const card = accents ? accents[(k - 1) % accents.length]! : p.primary;
    const bar = accents ? card.background : p.accent.background;
    const active = interactionPair({ foreground: card.background, background: card.foreground });
    return [
      `--card-${k}-fg: ${card.foreground};`,
      `--card-${k}-bg: ${card.background};`,
      `--card-${k}-bar: ${bar};`,
      `--card-${k}-active-fg: ${active.foreground};`,
      `--card-${k}-active-bg: ${active.background};`,
    ];
  });
}

function palette(p: Palette): string[] {
  const lines = THEME_ROLES.flatMap((role) => [
    `--color-${role}-fg: ${p[role].foreground};`,
    `--color-${role}-bg: ${p[role].background};`,
  ]);
  for (const role of ['primary', 'accent', 'body'] as const) {
    const pair = interactionPair(p[role]);
    lines.push(
      `--color-${role}-active-fg: ${pair.foreground};`,
      `--color-${role}-active-bg: ${pair.background};`
    );
  }
  lines.push(
    `--color-caption-fg: ${captionForeground(p)};`,
    `--color-link: ${p.link};`,
    `--color-focus: ${p.focus};`,
    ...cardSlots(p)
  );
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
