// A theme's values as CSS custom properties (ADR 013 rule 1, brief #8c § 3): the one place a
// `ResolvedTheme` becomes CSS. `base.css` reads only these properties, so a tenant's theme changes
// the look without a line of tenant CSS. Every number is formatted here from a validated range and
// every colour is a validated `#RRGGBB`, so the output has a closed grammar the conformance suite
// checks over random themes.
//
// Served as a stylesheet route with the content hash in its path (`/_theme/<hash>.css`,
// immutable), not as `<style nonce>`: components have no nonce, and a stylesheet is cacheable
// across pages. Both palettes are explicit (light in `:root`, dark under `prefers-color-scheme`),
// never derived. The `@font-face` rules are here too, because the fonts are theme values and a
// site must not load a family it did not choose (`font-files.ts`).
//
// Rejected: component-local CSS and unchecked hover arithmetic. Interaction pairs keep the
// original polarity and are checked along the entire sRGB transition before becoming tokens.

import {
  campaignColours,
  contrastRatio,
  focusHalo,
  FONT_KEYS,
  luminance,
  preloadFace,
  siteFontFile,
  THEME_ROLES,
  type FontCategory,
  type Palette,
  type ResolvedTheme,
  type SiteFontFace,
  type SiteFontRole,
} from '@mycel/core';
import {
  faceRule,
  fontFaces,
  fontStack,
  italicFile,
  romanFile,
  siteFaceRule,
  siteFontStack,
} from './font-files.js';

/**
 * A site's uploaded fonts per role (MY-302, ADR 013 amendment of 2026-11-26). A role listed here
 * replaces the theme's catalogue font for that role: its faces are declared, the catalogue font's
 * are not (unless the other role still uses it), so a page never fetches a family it does not
 * show. The catalogue choice stays the face of mail and the share card.
 */
export type UploadedFonts = Partial<
  Record<SiteFontRole, { category: FontCategory; faces: readonly SiteFontFace[] }>
>;
const NO_UPLOADS: UploadedFonts = Object.freeze({});
/** Only a role with at least one face counts; an empty family declares nothing. */
const uploaded = (fonts: UploadedFonts, role: SiteFontRole) =>
  fonts[role]?.faces.length ? fonts[role] : undefined;

/**
 * The system's monospace for captions (`captionFont: 'mono'`): no file to load, so no preload or
 * `@font-face`. Only a theme that chooses it sets `--font-caption`; without it `media-blocks.css`
 * inherits the body face and the stylesheet stays byte for byte what it was.
 */
export const CAPTION_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/**
 * The roman files the first paint needs: the body's regular first, then the heading's at its
 * weight (one file when both are the same). `withItalicPreload` relies on that order. An uploaded
 * font's face is a path below the site instead (`SITE_FONT_PREFIX`), never a catalogue file.
 */
export function preloadFonts(
  theme: Pick<ResolvedTheme, 'headingFont' | 'bodyFont' | 'headingWeight'>,
  fonts: UploadedFonts = NO_UPLOADS
): string[] {
  const file = (role: SiteFontRole, key: ResolvedTheme['bodyFont'], weight: number) => {
    const font = uploaded(fonts, role);
    if (!font) return [romanFile(key, weight)];
    const face = preloadFace(font.faces, weight);
    return face ? [`${SITE_FONT_PREFIX}${siteFontFile(role, face)}`] : [];
  };
  return [
    ...new Set([
      ...file('body', theme.bodyFont, 400),
      ...file('heading', theme.headingFont, theme.headingWeight),
    ]),
  ];
}

/**
 * Where an uploaded face lives below the site. A preload of one is this path, which the layout
 * puts under the public site or the preview (`siteFontHref`); a catalogue file is absolute and the
 * same on every host.
 */
export const SITE_FONT_PREFIX = '/_font/';
export const siteFontHref = (preload: string, base: string): string =>
  preload.startsWith(SITE_FONT_PREFIX) ? `${base}${preload}` : preload;

// Elements a browser renders italic by default; no stylesheet here sets `font-style` itself.
const ITALIC_ELEMENT = /<(?:em|i|cite|dfn|var|address)[\s>]/;
// The first font preload of any origin: an uploaded body font (MY-302) comes first and has no
// catalogue italic, so a page with one gets none from here.
const FIRST_FONT_PRELOAD = /<link rel="preload" href="([^"]+)" as="font"[^>]*>/;
/** Each catalogue font's regular body file to its italic, for the fonts that have one. */
const ITALIC_OF = new Map(
  FONT_KEYS.flatMap((key) => {
    const italic = italicFile(key);
    return italic ? [[romanFile(key, 400), italic] as const] : [];
  })
);

/**
 * The body font's italic face as a low-priority preload, after its roman one, on a rendered page
 * whose body uses italic text. Discovered during layout instead, the font is fetched at the
 * highest priority, which Lighthouse counts as render-blocking although `font-display: swap` lets
 * text paint before it arrives: up to 116 KB on the first paint's critical path. Low priority
 * keeps it off that path and out of the LCP image's way. Pages without italic text never fetch it,
 * and neither does a body font without an italic. Only the body face: headings and pull quotes
 * are plain text and never italic. The first font preload is the body's (`preloadFonts`).
 * Rejected: preloading the italic face on every page (wasted bytes on most of them), and listing
 * the italic-emitting components (a new one would silently bring the cost back).
 */
export function withItalicPreload(html: string): string {
  const roman = FIRST_FONT_PRELOAD.exec(html);
  const file = roman && ITALIC_OF.get(roman[1]!);
  if (!roman || !file) return html;
  const body = html.indexOf('<body');
  if (body < 0 || !ITALIC_ELEMENT.test(html.slice(body))) return html;
  const italic = `<link rel="preload" href="${file}" as="font" type="font/woff2" crossorigin="anonymous" fetchpriority="low">`;
  const end = roman.index + roman[0].length;
  return html.slice(0, end) + italic + html.slice(end);
}

/** The `@font-face` rules of the chosen families only; one family when heading and body agree. */
function fontFaceRules(
  theme: Pick<ResolvedTheme, 'headingFont' | 'bodyFont'>,
  fonts: UploadedFonts
): string {
  const catalogue = [
    ...(uploaded(fonts, 'body') ? [] : [theme.bodyFont]),
    ...(uploaded(fonts, 'heading') ? [] : [theme.headingFont]),
  ];
  const site = (['body', 'heading'] as const).flatMap(
    (role) => uploaded(fonts, role)?.faces.map((f) => siteFaceRule(role, f)) ?? []
  );
  return [
    ...[...new Set(catalogue)].flatMap((key) => fontFaces(key).map((f) => faceRule(key, f))),
    ...site,
  ].join('\n');
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
 * Captions are quieter than the surrounding text (P185-79): move the foreground towards the
 * actual background by up to a quarter of the way. A pair with no contrast to spare keeps its
 * original foreground. Here and not with `color-mix` in the stylesheet, which
 * cannot know the result's contrast.
 */
function captionForeground(foreground: string, background: string): string {
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
    return [
      `--card-${k}-fg: ${card.foreground};`,
      `--card-${k}-bg: ${card.background};`,
      `--card-${k}-bar: ${bar};`,
    ];
  });
}

/**
 * The site header and footer as the role pairs the theme chose for them (MY-266), copied, never
 * computed, so their text and focus contrast is what `checkTheme` already measured. The header's
 * first call to action is `--chrome-action-*`: the primary pair, or, on a primary header where a
 * primary button would vanish into the bar, that pair inverted (same contrast); hovered, it inverts
 * like every public button (controls/button.css, MY-279). Rejected: a CSS rule that swaps the
 * button per header role (the stylesheet would have to know which roles look alike) and
 * `color-mix` towards a header colour (no contrast check can see it).
 */
function chromeTokens(p: Palette, chrome: ResolvedTheme['chrome']): string[] {
  const header = p[chrome.header];
  const footer = p[chrome.footer];
  const action =
    chrome.header === 'primary'
      ? { foreground: p.primary.background, background: p.primary.foreground }
      : p.primary;
  return [
    `--chrome-header-fg: ${header.foreground};`,
    `--chrome-header-bg: ${header.background};`,
    `--chrome-footer-fg: ${footer.foreground};`,
    `--chrome-footer-bg: ${footer.background};`,
    `--chrome-action-fg: ${action.foreground};`,
    `--chrome-action-bg: ${action.background};`,
  ];
}

function palette(p: Palette, chrome: ResolvedTheme['chrome']): string[] {
  const { form, progress, fill } = campaignColours(p);
  const ctaHighlight = p.ctaHighlight ?? p.primary;
  const lines = THEME_ROLES.flatMap((role) => [
    `--color-${role}-fg: ${p[role].foreground};`,
    `--color-${role}-bg: ${p[role].background};`,
  ]);
  // The FAQ bar's softened hover (base.css); buttons invert instead (controls/button.css, MY-279).
  const active = interactionPair(p.primary);
  lines.push(
    `--color-primary-active-fg: ${active.foreground};`,
    `--color-primary-active-bg: ${active.background};`
  );
  lines.push(
    `--color-caption-fg: ${captionForeground(p.muted.foreground, p.body.background)};`,
    `--color-surface-caption-fg: ${captionForeground(p.surface.foreground, p.surface.background)};`,
    `--color-link: ${p.link};`,
    `--color-focus: ${p.focus};`,
    `--color-focus-halo: ${focusHalo(p)};`,
    `--cta-highlight-fg: ${ctaHighlight.foreground};`,
    `--cta-highlight-bg: ${ctaHighlight.background};`,
    `--campaign-form-fg: ${form.foreground};`,
    `--campaign-form-bg: ${form.background};`,
    `--campaign-progress-fg: ${progress.foreground};`,
    `--campaign-progress-bg: ${progress.background};`,
    `--campaign-progress-fill: ${fill};`,
    ...cardSlots(p),
    ...chromeTokens(p, chrome)
  );
  return lines;
}

/** Steps below and above the base size, from `baseSize * scaleRatio^n`, in rem of 16 px. */
export const STEPS = [-1, 0, 1, 2, 3, 4] as const;
const stepName = (n: number) => (n < 0 ? `--step--${-n}` : `--step-${n}`);

/**
 * Cross-document view transitions (MY-269): both pages of a same-origin click carry this rule, so
 * the browser cross-fades between them, with the header and footer standing still under their
 * fixed names (`site-chrome.css`). Only for a reader who has not asked for reduced motion, and
 * only in the theme stylesheet, so a site that switched it off has no rule at all instead of a
 * rule to override. A browser without support navigates as before. Rejected: SvelteKit's
 * `onNavigate` (the public site has no client router, `csr = false`) and a script that starts
 * the transition (the at-rule needs none).
 */
export const PAGE_TRANSITION_RULE =
  '@media (prefers-reduced-motion: no-preference) {\n  @view-transition {\n    navigation: auto;\n  }\n}';

export function themeCss(theme: ResolvedTheme, fonts: UploadedFonts = NO_UPLOADS): string {
  const body = uploaded(fonts, 'body');
  const heading = uploaded(fonts, 'heading');
  const sizes = STEPS.map(
    (n) => `${stepName(n)}: ${num((theme.baseSize * theme.scaleRatio ** n) / 16)}rem;`
  );
  const root = [
    ...palette(theme.palettes.light, theme.chrome),
    `--font-body: ${body ? siteFontStack('body', body.category) : fontStack(theme.bodyFont)};`,
    `--font-heading: ${heading ? siteFontStack('heading', heading.category) : fontStack(theme.headingFont)};`,
    ...(theme.captionFont === 'mono' ? [`--font-caption: ${CAPTION_MONO};`] : []),
    `--heading-weight: ${theme.headingWeight};`,
    // Capitals set a little wider, or they read as a block (MY-283); absent is as written.
    ...(theme.headingCase === 'upper'
      ? ['--heading-case: uppercase;', '--heading-tracking: 0.04em;']
      : []),
    ...sizes,
    `--measure: ${num(theme.measure)}ch;`,
    `--radius: ${num(theme.radius / 16)}rem;`,
    ...(theme.buttonShape === 'pill' ? ['--button-radius: 999px;'] : []),
    `--density: ${num(theme.density)};`,
    'color-scheme: light dark;',
  ];
  const indent = (lines: string[], by: string) => lines.map((l) => `${by}${l}`).join('\n');
  return [
    fontFaceRules(theme, fonts),
    `:root {\n${indent(root, '  ')}\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root {\n${indent(palette(theme.palettes.dark, theme.chrome), '    ')}\n  }\n}`,
    ...(theme.pageTransitions === 'off' ? [] : [PAGE_TRANSITION_RULE]),
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
