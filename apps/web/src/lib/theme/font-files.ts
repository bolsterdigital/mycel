// The self-hosted files of the font catalogue (`@mycel/core` `FONTS`, docs/reference/fonts.md):
// the `@font-face` rules a theme declares, the files a page preloads and the italic a page with
// italic text adds. Only the two chosen families appear in a theme's stylesheet, so a site never
// downloads a face it does not use.
//
// Three shapes of files: a variable Latin subset (one roman, one italic), a static Latin subset
// (one file per weight, italic at 400 and 700), and a family with a Reserved Font Name shipped as
// its unmodified font in WOFF2 (all scripts, so no `unicode-range`; OFL-FAQ 2.2).
// Rejected: deriving paths from the key alone (Inter's italic is instanced to 400-700 and Mycel
// Serif's files keep their origin's name), and one file per weight for every family (a variable
// font is one download whatever the heading weight).

import {
  FONTS,
  siteFontFamily,
  siteFontFile,
  type FontCategory,
  type FontKey,
  type SiteFontFace,
  type SiteFontRole,
} from '@mycel/core';

/** The Latin subset of the files that are subset (`fonts.md`), as a `unicode-range`. */
export const LATIN =
  'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

/** Where a file cannot load: the system face of the same category. A slab falls back to serif. */
const FALLBACK: Record<FontCategory, string> = {
  sans: "system-ui, -apple-system, 'Segoe UI', sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  slab: "Georgia, 'Times New Roman', serif",
};

export interface FontFace {
  file: string;
  style: 'normal' | 'italic';
  /** A CSS `font-weight` descriptor: one weight or a variable range. */
  weight: string;
  /** False for the unmodified fonts with a Reserved Font Name, which carry every script. */
  latin: boolean;
}

type Shape =
  | { kind: 'variable'; dir: string; roman: string; italic: string | null }
  | { kind: 'full'; roman: string; italic: string | null }
  | { kind: 'static'; weights: readonly number[]; italics: readonly number[] };

const SHAPES: Record<FontKey, Shape> = {
  inter: { kind: 'variable', dir: 'inter', roman: '100 900', italic: '400 700' },
  'mycel-serif': { kind: 'variable', dir: 'source-serif-4', roman: '200 900', italic: '200 900' },
  'open-sans': { kind: 'variable', dir: 'open-sans', roman: '300 800', italic: '300 800' },
  rubik: { kind: 'variable', dir: 'rubik', roman: '300 900', italic: '300 900' },
  roboto: { kind: 'variable', dir: 'roboto', roman: '100 900', italic: '100 900' },
  'work-sans': { kind: 'variable', dir: 'work-sans', roman: '100 900', italic: '100 900' },
  gabarito: { kind: 'variable', dir: 'gabarito', roman: '400 900', italic: null },
  raleway: { kind: 'full', roman: '100 900', italic: '100 900' },
  quicksand: { kind: 'full', roman: '300 700', italic: null },
  'source-sans-3': { kind: 'full', roman: '200 900', italic: '200 900' },
  poppins: { kind: 'static', weights: [400, 500, 600, 700, 800], italics: [400, 700] },
  'zilla-slab': { kind: 'static', weights: [400, 500, 600, 700], italics: [400, 700] },
  'vesper-libre': { kind: 'static', weights: [400, 500, 700], italics: [] },
};

/** Every face of a catalogue font, in declaration order. */
export function fontFaces(key: FontKey): FontFace[] {
  const shape = SHAPES[key];
  const at = (name: string) => `/fonts/${key}/${key}-${name}.woff2`;
  if (shape.kind === 'variable') {
    const file = (style: string) => `/fonts/${shape.dir}/${shape.dir}-latin-${style}.woff2`;
    return [
      { file: file('roman'), style: 'normal', weight: shape.roman, latin: true },
      ...(shape.italic
        ? [{ file: file('italic'), style: 'italic' as const, weight: shape.italic, latin: true }]
        : []),
    ];
  }
  if (shape.kind === 'full')
    return [
      { file: at('roman'), style: 'normal', weight: shape.roman, latin: false },
      ...(shape.italic
        ? [{ file: at('italic'), style: 'italic' as const, weight: shape.italic, latin: false }]
        : []),
    ];
  return [
    ...shape.weights.map((w) => ({
      file: at(`latin-${w}`),
      style: 'normal' as const,
      weight: String(w),
      latin: true,
    })),
    ...shape.italics.map((w) => ({
      file: at(`latin-${w}-italic`),
      style: 'italic' as const,
      weight: String(w),
      latin: true,
    })),
  ];
}

/** The face a browser picks for `style` at `weight`: the one whose descriptor covers it. */
function faceAt(key: FontKey, style: FontFace['style'], weight: number): FontFace | undefined {
  return fontFaces(key).find((f) => {
    if (f.style !== style) return false;
    const [min, max = min] = f.weight.split(' ').map(Number) as [number, number?];
    return weight >= min && weight <= max;
  });
}

/** The roman file the first paint needs for text at `weight`. */
export function romanFile(key: FontKey, weight: number): string {
  const face = faceAt(key, 'normal', weight);
  if (!face) throw new RangeError(`${key} has no face at ${weight}`);
  return face.file;
}

/** The body text's italic file, or null where the family has none and the browser slants. */
export function italicFile(key: FontKey): string | null {
  return faceAt(key, 'italic', 400)?.file ?? null;
}

/** The CSS family with its quoted name, for `font-family` and `@font-face`. */
export const familyName = (key: FontKey): string => `'${FONTS[key].family}'`;

/** The `font-family` value of a catalogue font: its own family, then its category's fallback. */
export const fontStack = (key: FontKey): string =>
  `${familyName(key)}, ${FALLBACK[FONTS[key].category]}`;

/** The stack of a site's uploaded font (MY-302): its fixed CSS name, then the system face. */
export const siteFontStack = (role: SiteFontRole, category: FontCategory): string =>
  `'${siteFontFamily(role)}', ${FALLBACK[category]}`;

/**
 * One `@font-face` rule of an uploaded face. Every part is closed: the family is fixed text, the
 * file name is role, weight, style and hex (`siteFontFile`), weight and style are validated, so
 * nothing the uploader typed reaches the stylesheet. Relative to the theme stylesheet, which is
 * served at `<site>/_theme/<hash>.css` and in the preview at `<preview>/_theme/<hash>.css`.
 */
export const siteFaceRule = (role: SiteFontRole, f: SiteFontFace): string =>
  `@font-face { font-family: '${siteFontFamily(role)}'; src: url('../_font/${siteFontFile(role, f)}') format('woff2'); font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap; }`;

/** One `@font-face` rule; only a subset file carries the Latin `unicode-range`. */
export const faceRule = (key: FontKey, f: FontFace): string =>
  `@font-face { font-family: ${familyName(key)}; src: url('${f.file}') format('woff2'); font-style: ${f.style}; font-weight: ${f.weight}; font-display: swap;${f.latin ? ` unicode-range: ${LATIN};` : ''} }`;

/** The admin's font picker shows each specimen at these weights: body text and a bold heading. */
const SPECIMEN_WEIGHTS = [400, 700];

/**
 * The stylesheet of the font picker in the admin (MY-261 PR 2), served as the static file
 * `static/_admin/font-specimens.css` and linked only by the theme settings, so no other page
 * downloads the catalogue. Per family only the roman faces a specimen needs (a variable file
 * covers both weights, a static family gets its 400 and 700), and per key one rule on
 * `.ui-font-specimen[data-font]`, plus the specimen's own layout (it is used nowhere else). A test
 * holds the file equal to this output.
 * Rejected: a server route that builds it per request (the catalogue only changes with a release)
 * and inline `style=` per option (CSP `style-src 'self'`, ADR 009).
 */
export function specimenCss(): string {
  const keys = Object.keys(FONTS) as FontKey[];
  const faces = keys.flatMap((key) =>
    fontFaces(key)
      .filter((f) => SPECIMEN_WEIGHTS.some((w) => romanFile(key, w) === f.file))
      .map((f) => faceRule(key, f))
  );
  const rules = keys.map(
    (key) => `.ui-font-specimen[data-font='${key}'] { font-family: ${fontStack(key)}; }`
  );
  return [
    '/* Generated by specimenCss() in src/lib/theme/font-files.ts; tokens.test.ts holds it equal. */',
    ...faces,
    // The family's name above, under it a line in that font; a heading's line is bold. The line
    // height is the font's own (`normal`): a fixed 1.3 clips the tall faces of Poppins, Source
    // Sans 3 and Vesper Libre in the label's box.
    '.ui-font-specimen { display: block; font-size: 1.25rem; line-height: normal; }',
    '.ui-font-specimen.heading { font-weight: 700; }',
    ...rules,
    '',
  ].join('\n');
}
