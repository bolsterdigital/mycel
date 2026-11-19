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

import { FONTS, type FontKey } from '@mycel/core';

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
