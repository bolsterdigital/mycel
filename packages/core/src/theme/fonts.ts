// The font catalogue a theme chooses from (ADR 013 rule 1, amended 2026-11-19): a heading font
// and a body font, each a key here, never a name or a URL. The renderer self-hosts the files with
// their licences (`apps/web/static/fonts`, docs/reference/fonts.md) and the share card draws the
// heading font (`packages/media-sharp/fonts`). The families are the ones the Dreamkit sites use
// (MY-261), so a migrated site keeps its letters. Adding one is a product change (rule 5).
//
// Rejected: font pairs (twelve headings by twelve body faces is a list nobody reads, and the
// Dreamkit sites combine them freely) and a free Google font name (an external URL, ADR 009 rule 4).

export const FONT_CATEGORIES = ['sans', 'serif', 'slab'] as const;
export type FontCategory = (typeof FONT_CATEGORIES)[number];

export interface CatalogueFont {
  /** The CSS family name the renderer declares; also the label in the admin. */
  family: string;
  /** Picks the fallback stack where the file cannot load: mail and a failed download. */
  category: FontCategory;
  /** A variable font's weight range, or a static font's weights, each a file of its own. */
  weights: { min: number; max: number } | readonly number[];
  /** Whether the family has an italic; without one the browser slants the roman. */
  italic: boolean;
}

export const FONTS = {
  inter: { family: 'Inter', category: 'sans', weights: { min: 100, max: 900 }, italic: true },
  'mycel-serif': {
    family: 'Mycel Serif',
    category: 'serif',
    weights: { min: 200, max: 900 },
    italic: true,
  },
  'open-sans': {
    family: 'Open Sans',
    category: 'sans',
    weights: { min: 300, max: 800 },
    italic: true,
  },
  rubik: { family: 'Rubik', category: 'sans', weights: { min: 300, max: 900 }, italic: true },
  roboto: { family: 'Roboto', category: 'sans', weights: { min: 100, max: 900 }, italic: true },
  raleway: { family: 'Raleway', category: 'sans', weights: { min: 100, max: 900 }, italic: true },
  'work-sans': {
    family: 'Work Sans',
    category: 'sans',
    weights: { min: 100, max: 900 },
    italic: true,
  },
  poppins: {
    family: 'Poppins',
    category: 'sans',
    weights: [400, 500, 600, 700, 800],
    italic: true,
  },
  quicksand: {
    family: 'Quicksand',
    category: 'sans',
    weights: { min: 300, max: 700 },
    italic: false,
  },
  gabarito: {
    family: 'Gabarito',
    category: 'sans',
    weights: { min: 400, max: 900 },
    italic: false,
  },
  'source-sans-3': {
    family: 'Source Sans 3',
    category: 'sans',
    weights: { min: 200, max: 900 },
    italic: true,
  },
  'zilla-slab': {
    family: 'Zilla Slab',
    category: 'slab',
    weights: [400, 500, 600, 700],
    italic: true,
  },
  'vesper-libre': {
    family: 'Vesper Libre',
    category: 'serif',
    weights: [400, 500, 700],
    italic: false,
  },
} as const satisfies Record<string, CatalogueFont>;

export type FontKey = keyof typeof FONTS;
export const FONT_KEYS = Object.keys(FONTS) as [FontKey, ...FontKey[]];

/** Whether a catalogue font has a face at this weight, so a heading never gets a faux bold. */
export function hasWeight(key: FontKey, weight: number): boolean {
  const { weights } = FONTS[key] as CatalogueFont;
  return 'min' in weights
    ? weight >= weights.min && weight <= weights.max
    : weights.includes(weight);
}
