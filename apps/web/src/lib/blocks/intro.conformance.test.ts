// The public item page around its blocks (#86): title, lead, hero image with caption and credit,
// then the blocks, and the drop cap as an attribute the theme decides. Rendered from the real
// route component for two locales and two themes (a default theme with drop caps, the editorial
// preset with them switched off), with an HTML snapshot each, reviewed like the block snapshots.

import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import {
  Block,
  ContentDocument,
  DEFAULT_THEME,
  THEME_PRESETS,
  effectiveImages,
  projectDocument,
  resolveTheme,
  type MediaView,
} from '@mycel/core';
import Page from '../../routes/(public)/[tenant]/[[locale=locale]]/[...path]/+page.svelte';
import { resolveDocument, resolveIntro, type ResolveSource } from './resolve.js';

const HERO = '01900000-0000-7000-8000-0000000086a1';

const hero: MediaView = {
  id: HERO,
  kind: 'image',
  contentType: 'image/jpeg',
  filename: 'hero.jpg',
  width: 1600,
  height: 900,
  sizeBytes: 1,
  totalBytes: 1,
  checksum: 'x',
  access: 'public',
  caption: { nl: 'Het plein op zaterdag', en: 'The square on Saturday' },
  credit: { work: null, photographer: 'Archief' },
  source: null,
  licence: null,
  focal: { x: 0.5, y: 0.5 },
  state: 'ready',
  usageCount: 1,
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  variants: [640, 1280].flatMap((w) =>
    (['avif', 'webp'] as const).map((f) => ({
      name: `w${w}`,
      format: f,
      width: w,
      height: (w * 9) / 16,
      path: `/media/${HERO}/w${w}.${f}`,
    }))
  ),
};

const source: ResolveSource = {
  form: async () => null,
  media: async (id) => (id === HERO ? hero : null),
  itemPath: async () => null,
};

const article = ContentDocument.parse({
  type: 'article',
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: 'Drie jaar lobby', en: 'Three years of lobbying' },
  lead: { nl: 'Na drie jaar is het besluit er.', en: 'After three years the decision is in.' },
  heroImageId: HERO,
  blocks: [
    Block.parse({
      id: 'body',
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Op het plein.' }] }],
          },
          en: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'On the square.' }] }],
          },
        },
      },
    }),
  ],
});

const THEMES = {
  default: DEFAULT_THEME,
  'editorial-off': { ...THEME_PRESETS.editorial, dropCap: 'off' as const },
};

const prettierConfig = await resolveConfig(fileURLToPath(import.meta.url));

async function page(
  locale: 'nl' | 'en',
  theme: keyof typeof THEMES,
  heroAlt: Partial<Record<string, string>> | undefined = undefined
) {
  const model = await resolveDocument(
    source,
    { locale, ...projectDocument(article, locale) },
    { base: '', fallbackLocale: 'nl' }
  );
  const intro = await resolveIntro(
    source,
    {
      lead: article.lead?.[locale] ?? null,
      heroImageId: effectiveImages(article).hero.mediaId,
      heroAlt: heroAlt?.[locale] ?? null,
    },
    locale
  );
  const data = {
    view: 'item' as const,
    model,
    intro,
    dropCap: resolveTheme(THEMES[theme]).dropCap === 'articles',
    head: {
      canonical: '/',
      alternates: [],
      description: null,
      share: { title: model.title, type: 'article' as const },
      image: null,
    },
    errorPrefix: 'Fout:',
  };
  const body = render(Page, { props: { data, form: null } as never }).body.replace(
    /<!--[^>]*-->/g,
    ''
  );
  return format(body, { ...prettierConfig, parser: 'html' });
}

describe('the public item page (#86)', () => {
  for (const locale of ['nl', 'en'] as const)
    for (const theme of Object.keys(THEMES) as (keyof typeof THEMES)[])
      it(`renders title, lead, hero and body in ${locale} with the ${theme} theme`, async () => {
        const html = await page(locale, theme);
        await expect(html).toMatchFileSnapshot(`__snapshots__/item-intro-${theme}.${locale}.html`);
        // Reading order: title, lead, hero, blocks.
        const at = (s: string) => html.indexOf(s);
        expect(at('<h1')).toBeLessThan(at('class="lead"'));
        expect(at('class="lead"')).toBeLessThan(at('page-hero'));
        expect(at('page-hero')).toBeLessThan(at('rich-text'));
        // The hero is the first image and loads eagerly, with an intrinsic size.
        expect(html).toMatch(/<img[^>]*width="1600"[^>]*height="900"/);
        expect(html).not.toContain('loading="lazy"');
        expect(html.includes('data-drop-cap')).toBe(theme === 'default');
        expect(html).not.toMatch(/\sstyle=|<style|<script/);
        const other = locale === 'nl' ? /Three years|After three|square/ : /Drie jaar|plein/;
        expect(html).not.toMatch(other);
      });
});

describe('the hero image alt (#99)', () => {
  const described = { nl: 'Demonstranten op het plein', en: 'Protesters on the square' };
  for (const locale of ['nl', 'en'] as const)
    it(`describes a described hero in ${locale} and leaves a decorative one empty`, async () => {
      const img = (html: string) => /<img[^>]*>/.exec(html)?.[0] ?? '';
      expect(img(await page(locale, 'default', described))).toContain(`alt="${described[locale]}"`);
      expect(img(await page(locale, 'default'))).toContain('alt=""');
    });
});
