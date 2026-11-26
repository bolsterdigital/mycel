// A site's uploaded fonts in the theme stylesheet and the preloads (MY-302): the role it replaces
// declares only the uploaded faces under the fixed family name, the other role keeps its
// catalogue font, no uploaded text reaches the CSS, and the first preload stays the body's so the
// italic preload never picks the heading's file.
import { DEFAULT_THEME, type ResolvedTheme, type SiteFontFace } from '@mycel/core';
import { describe, expect, it } from 'vitest';
import { parseSiteFontFile } from '../server/public/fonts/site-fonts.js';
import { preloadFonts, siteFontHref, themeCss, withItalicPreload } from './tokens.js';

const hash = (c: string) => c.repeat(64);
const face = (weight: number, style: 'normal' | 'italic', c: string): SiteFontFace => ({
  weight,
  style,
  sha256: hash(c),
  bytes: 1000,
});
const theme: ResolvedTheme = {
  ...DEFAULT_THEME,
  headingFont: 'rubik',
  bodyFont: 'inter',
  headingWeight: 700,
};
const heading = {
  category: 'serif' as const,
  faces: [face(700, 'normal', 'a'), face(400, 'italic', 'b')],
};

describe('uploaded site fonts', () => {
  it('replaces the heading font with the uploaded faces and keeps the body catalogue font', () => {
    const css = themeCss(theme, { heading });
    expect(css).toContain(
      `@font-face { font-family: 'Mycel Site Heading'; src: url('../_font/heading-700-normal-${'a'.repeat(16)}.woff2') format('woff2'); font-style: normal; font-weight: 700; font-display: swap; }`
    );
    expect(css).toContain(
      "--font-heading: 'Mycel Site Heading', Georgia, 'Times New Roman', serif;"
    );
    expect(css).not.toContain("font-family: 'Rubik'");
    expect(css).toContain("font-family: 'Inter'");
    expect(css).toContain("--font-body: 'Inter',");
  });

  it('is the catalogue stylesheet byte for byte without uploads, or with an empty family', () => {
    expect(themeCss(theme, {})).toBe(themeCss(theme));
    expect(themeCss(theme, { body: { category: 'sans', faces: [] } })).toBe(themeCss(theme));
  });

  it('keeps a catalogue font both roles share when only one role is uploaded', () => {
    const shared = { ...theme, headingFont: 'inter' as const };
    expect(themeCss(shared, { heading })).toContain("font-family: 'Inter'");
  });

  it('preloads the body first and an uploaded face as a path below the site', () => {
    const body = {
      category: 'sans' as const,
      faces: [face(400, 'normal', 'c'), face(700, 'normal', 'd')],
    };
    const preload = preloadFonts(theme, { body });
    expect(preload[0]).toBe(`/_font/body-400-normal-${'c'.repeat(16)}.woff2`);
    expect(preload[1]).toMatch(/^\/fonts\/rubik\//);
    expect(siteFontHref(preload[0]!, '/admin/x/preview')).toBe(`/admin/x/preview${preload[0]}`);
    expect(siteFontHref(preload[1]!, '/admin/x/preview')).toBe(preload[1]);
    const html = preload
      .map(
        (p) =>
          `<link rel="preload" href="${p}" as="font" type="font/woff2" crossorigin="anonymous">`
      )
      .join('');
    // An uploaded body font has no catalogue italic: the heading's italic is never preloaded.
    expect(withItalicPreload(`${html}<body><em>x</em>`)).toBe(`${html}<body><em>x</em>`);
  });

  it('serves only file names of the closed shape', () => {
    expect(parseSiteFontFile(`heading-700-normal-${'a'.repeat(16)}.woff2`)).toEqual({
      role: 'heading',
      weight: 700,
      style: 'normal',
    });
    for (const bad of [
      `heading-750-normal-${'a'.repeat(16)}.woff2`,
      `logo-700-normal-${'a'.repeat(16)}.woff2`,
      `heading-700-normal-${'A'.repeat(16)}.woff2`,
      `heading-700-normal-${'a'.repeat(16)}.woff`,
      `../heading-700-normal-${'a'.repeat(16)}.woff2`,
    ])
      expect(parseSiteFontFile(bad)).toBeNull();
  });
});
