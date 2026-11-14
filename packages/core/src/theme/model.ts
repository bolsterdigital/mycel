// A tenant's theme as validated values (ADR 013 rule 1): colours per role pair, a closed font
// catalogue and bounded numbers, never CSS. Two schemas share one check: `ThemeInput` is the
// structure (shape, ranges, closed sets) that `site.theme.check` accepts so an editor can explain a
// contrast failure, and `Theme` is what every later write parses, which also refuses a theme
// whose contrast fails. The mapping to CSS custom properties belongs to the renderer (#8c,
// `apps/web/src/lib/theme`); nothing here knows CSS.
//
// Both palettes are explicit and complete: whoever changes colours sends light and dark, so no
// unrelated dark default lands on top of a brand's own light design. Rejected: deriving dark mode
// from light (a computed palette nobody chose, which then fails contrast in ways no editor can
// fix in one field), and accepting font names or URLs (fonts are a product catalogue the
// renderer self-hosts).

import { z } from 'zod';

export const THEME_VERSION = 1;

/** Curated font pairs (headings, body); #8c self-hosts the files with their licences. */
export const FONT_PAIRS = ['inter', 'source-serif-inter'] as const;
export type FontPair = (typeof FONT_PAIRS)[number];

export const HEADING_WEIGHTS = [400, 500, 600, 700, 800] as const;

/** Where the first letter of the body is a drop cap in the accent colour (#86); a site choice. */
export const DROP_CAPS = ['articles', 'off'] as const;
export type DropCap = (typeof DROP_CAPS)[number];

/**
 * The face of captions and credits: the body font, or the system's monospace (a house style that
 * sets its photo captions like a typewriter). A closed choice, so `body` renders exactly as before.
 * Rejected: a self-hosted monospace file (a licence and a catalogue entry for one small line of
 * text) and a free font name (ADR 013 rule 1 accepts values, never CSS).
 */
export const CAPTION_FONTS = ['body', 'mono'] as const;
export type CaptionFont = (typeof CAPTION_FONTS)[number];

/** The role pairs of a palette: each a foreground on its background. */
export const THEME_ROLES = ['body', 'surface', 'primary', 'accent', 'muted', 'warning'] as const;

export const THEME_MODES = ['light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** Bounded numbers: px-equivalents and factors the renderer turns into rem and ch. */
export const THEME_RANGES = {
  baseSize: { min: 16, max: 22, default: 18 },
  scaleRatio: { min: 1.125, max: 1.5, default: 1.25 },
  measure: { min: 45, max: 85, default: 65 },
  radius: { min: 0, max: 24, default: 4 },
  density: { min: 0.8, max: 1.3, default: 1 },
} as const;
type RangeName = keyof typeof THEME_RANGES;

const notAllowed = { error: 'theme.value.not-allowed' };
const unknownKey = {
  error: (issue: { code: string }) =>
    issue.code === 'unrecognized_keys' ? 'theme.key.unknown' : undefined,
};

/** An opaque sRGB colour; no alpha, names, functions or CSS expressions. */
export const ThemeColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'theme.color.invalid');

const RolePair = z.object({ foreground: ThemeColor, background: ThemeColor }, unknownKey).strict();

/** At most as many accents as an action row has cards; one is a row in one colour. */
export const CARD_ACCENTS_MAX = 4;

export const Palette = z
  .object(
    {
      body: RolePair,
      surface: RolePair,
      primary: RolePair,
      accent: RolePair,
      muted: RolePair,
      warning: RolePair,
      /** Link text on body and surface; #8c keeps links underlined. */
      link: ThemeColor,
      /** The focus indicator on every role background. */
      focus: ThemeColor,
      /**
       * The colours an action row walks through, card by card (Dreamkit
       * `action_card_accents`): the background is the bar and the filled card, the foreground the
       * text on that card. Absent, a bar takes `accent` and a filled card `primary`, as before.
       * The site chooses them, never the editor of a page. Rejected: one colour per card in the
       * block (a page decision no site-wide change can reach) and deriving a walk from the roles
       * (colours nobody chose).
       */
      cardAccents: z
        .array(RolePair)
        .min(1, notAllowed)
        .max(CARD_ACCENTS_MAX, notAllowed)
        .optional(),
    },
    unknownKey
  )
  .strict();
export type Palette = z.infer<typeof Palette>;

const range = (name: RangeName) =>
  z
    .number({
      error: (issue) =>
        issue.input === Infinity || issue.input === -Infinity
          ? 'theme.value.out-of-range'
          : 'theme.value.not-allowed',
    })
    .min(THEME_RANGES[name].min, 'theme.value.out-of-range')
    .max(THEME_RANGES[name].max, 'theme.value.out-of-range');

const HeadingWeight = z.union(
  HEADING_WEIGHTS.map((w) => z.literal(w)) as unknown as [
    z.ZodLiteral<400>,
    z.ZodLiteral<500>,
    z.ZodLiteral<600>,
    z.ZodLiteral<700>,
    z.ZodLiteral<800>,
  ],
  notAllowed
);

/** The structure of a theme; absent values take the defaults in `resolveTheme`. */
export const ThemeInput = z
  .object(
    {
      version: z.literal(THEME_VERSION, notAllowed).default(THEME_VERSION),
      palettes: z.object({ light: Palette, dark: Palette }, unknownKey).strict().optional(),
      fontPair: z.enum(FONT_PAIRS, notAllowed).optional(),
      baseSize: range('baseSize').optional(),
      scaleRatio: range('scaleRatio').optional(),
      measure: range('measure').optional(),
      radius: range('radius').optional(),
      density: range('density').optional(),
      headingWeight: HeadingWeight.optional(),
      dropCap: z.enum(DROP_CAPS, notAllowed).optional(),
      captionFont: z.enum(CAPTION_FONTS, notAllowed).optional(),
    },
    unknownKey
  )
  .strict();
export type ThemeInput = z.infer<typeof ThemeInput>;

/** Every value explicit: what the renderer applies and a theme write stores. */
export interface ResolvedTheme {
  version: typeof THEME_VERSION;
  palettes: Record<ThemeMode, Palette>;
  fontPair: FontPair;
  baseSize: number;
  scaleRatio: number;
  measure: number;
  radius: number;
  density: number;
  headingWeight: (typeof HEADING_WEIGHTS)[number];
  dropCap: DropCap;
  captionFont: CaptionFont;
}
