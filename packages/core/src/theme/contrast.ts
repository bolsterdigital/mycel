// The one contrast check of a theme (ADR 013 rule 1, WCAG 2.2): `site.theme.check` reports it and
// `Theme` refuses on it, so the editor's explanation and the write can never disagree. Every
// text pair needs 4.5:1; body text at 7:1 is reported as AAA, not required. Links need 4.5:1 on
// body and surface, the focus indicator 3:1 on every role background it can appear on. Ratios are
// compared unrounded; only the report rounds.

import { z } from 'zod';
import {
  THEME_MODES,
  THEME_RANGES,
  THEME_ROLES,
  ThemeInput,
  type Palette,
  type ResolvedTheme,
  type ThemeMode,
} from './model.js';
import { DEFAULT_THEME } from './presets.js';

export const TEXT_CONTRAST = 4.5;
export const AAA_CONTRAST = 7;
export const FOCUS_CONTRAST = 3;

/** WCAG relative luminance of an opaque `#RRGGBB` colour. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** The contrast ratio of two colours, from 1 to 21, unrounded. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const ThemePairReport = z.object({
  mode: z.enum(THEME_MODES),
  /** A role (`primary`), or `link-on-<role>` / `focus-on-<role>`. */
  role: z.string(),
  /** Rounded to two decimals for display; `passes` used the exact value. */
  ratio: z.number(),
  required: z.number(),
  passes: z.boolean(),
  /** Body text only: whether it also meets 7:1. */
  aaa: z.boolean().optional(),
});
export type ThemePairReport = z.infer<typeof ThemePairReport>;

export const ThemeReport = z.object({
  valid: z.boolean(),
  pairs: z.array(ThemePairReport),
  /** Catalogue keys (`theme.contrast.too-low`), one per failing colour path. */
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export type ThemeReport = z.infer<typeof ThemeReport>;

/** Defaults made explicit; a given value is kept as it is, valid or not, never patched. */
export function resolveTheme(input: ThemeInput): ResolvedTheme {
  const value = <K extends keyof typeof THEME_RANGES>(k: K) => input[k] ?? THEME_RANGES[k].default;
  return {
    version: input.version,
    palettes: input.palettes ?? DEFAULT_THEME.palettes,
    fontPair: input.fontPair ?? DEFAULT_THEME.fontPair,
    baseSize: value('baseSize'),
    scaleRatio: value('scaleRatio'),
    measure: value('measure'),
    radius: value('radius'),
    density: value('density'),
    headingWeight: input.headingWeight ?? DEFAULT_THEME.headingWeight,
  };
}

function paletteReport(mode: ThemeMode, p: Palette): ThemePairReport[] {
  const pair = (role: string, a: string, b: string, required: number, aaa = false) => {
    const ratio = contrastRatio(a, b);
    return {
      mode,
      role,
      ratio: Math.round(ratio * 100) / 100,
      required,
      passes: ratio >= required,
      ...(aaa ? { aaa: ratio >= AAA_CONTRAST } : {}),
    };
  };
  return [
    ...THEME_ROLES.map((r) =>
      pair(r, p[r].foreground, p[r].background, TEXT_CONTRAST, r === 'body')
    ),
    ...(['body', 'surface'] as const).map((r) =>
      pair(`link-on-${r}`, p.link, p[r].background, TEXT_CONTRAST)
    ),
    ...THEME_ROLES.map((r) => pair(`focus-on-${r}`, p.focus, p[r].background, FOCUS_CONTRAST)),
  ];
}

/** The contrast report of a structurally valid theme, defaults resolved. */
export function checkTheme(input: ThemeInput): ThemeReport {
  const theme = resolveTheme(input);
  const pairs = THEME_MODES.flatMap((m) => paletteReport(m, theme.palettes[m]));
  const paths = new Set<string>();
  for (const p of pairs.filter((x) => !x.passes)) {
    const [kind] = p.role.split('-on-');
    paths.add(`palettes.${p.mode}.${kind}`);
  }
  const issues = [...paths].map((path) => ({ path, message: 'theme.contrast.too-low' }));
  return { valid: issues.length === 0, pairs, issues };
}

/**
 * A theme as every write stores it: the structure of `ThemeInput`, contrast that passes, every
 * default explicit. There is no theme write yet (#11); this is the schema it will use.
 */
export const Theme = ThemeInput.superRefine((input, ctx) => {
  for (const issue of checkTheme(input).issues)
    ctx.addIssue({ code: 'custom', path: issue.path.split('.'), message: issue.message });
}).transform(resolveTheme);
export type Theme = z.output<typeof Theme>;
