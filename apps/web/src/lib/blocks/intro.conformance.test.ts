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
import Credit from './Credit.svelte';
import { renderMeta, resolveDocument, resolveIntro, type ResolveSource } from './resolve.js';

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
  heroAlt: Partial<Record<string, string>> | undefined = undefined,
  head: { header?: 'standard' | 'cover'; hero?: boolean; meta?: boolean } = {}
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
      heroImageId: head.hero === false ? null : effectiveImages(article).hero.mediaId,
      heroAlt: heroAlt?.[locale] ?? null,
      ...(head.header ? { header: head.header } : {}),
      ...(head.meta
        ? {
            meta: renderMeta(
              {
                publishedAt: '2026-10-30T23:30:00.000Z',
                authors: ['Sam de Vries', 'Noor Aziz', 'Lena Bos'],
                section: 'Wonen',
              },
              locale,
              'Europe/Amsterdam'
            ),
          }
        : {}),
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

describe('the two article headers (#105)', () => {
  const at = (html: string, s: string) => html.indexOf(s);
  for (const locale of ['nl', 'en'] as const) {
    it(`standard in ${locale}: title, lead, hero, meta line, blocks`, async () => {
      const html = await page(locale, 'default', undefined, { header: 'standard', meta: true });
      await expect(html).toMatchFileSnapshot(`__snapshots__/item-intro-standard.${locale}.html`);
      expect(at(html, '<h1')).toBeLessThan(at(html, 'class="lead"'));
      expect(at(html, 'class="lead"')).toBeLessThan(at(html, 'page-hero'));
      expect(at(html, 'page-hero')).toBeLessThan(at(html, 'page-meta'));
      expect(at(html, 'page-meta')).toBeLessThan(at(html, 'rich-text'));
      expect(html).not.toContain('page-rule');
      expect(html).toContain('fetchpriority="high"');
      // Past midnight in the site's zone: the date there, in the attribute as well.
      expect(html).toContain('datetime="2026-10-31"');
      expect(html).toContain(locale === 'nl' ? '31 oktober 2026' : 'October 31, 2026');
      expect(html).toContain(
        locale === 'nl'
          ? 'door Sam de Vries, Noor Aziz en Lena Bos'
          : 'by Sam de Vries, Noor Aziz, and Lena Bos'
      );
    });

    it(`standard without a hero image in ${locale}: a thin line closes the header`, async () => {
      const html = await page(locale, 'default', undefined, { hero: false });
      await expect(html).toMatchFileSnapshot(
        `__snapshots__/item-intro-standard-no-hero.${locale}.html`
      );
      expect(at(html, 'class="lead"')).toBeLessThan(at(html, 'page-rule'));
      expect(at(html, 'page-rule')).toBeLessThan(at(html, 'rich-text'));
      expect(html).not.toContain('page-meta');
    });

    it(`cover in ${locale}: one h1 in marked lines, a real image, an arrow link`, async () => {
      const html = await page(locale, 'default', undefined, { header: 'cover', meta: true });
      await expect(html).toMatchFileSnapshot(`__snapshots__/item-intro-cover.${locale}.html`);
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toMatch(/<header class="page-cover">[\s\S]*<h1[^>]*>\s*<span>/);
      expect(html).toContain('sizes="100vw"');
      expect(html).toContain('fetchpriority="high"');
      expect(html).toContain('href="#page-content"');
      expect(html).toContain(
        `aria-label="${locale === 'nl' ? 'Naar de inhoud' : 'To the content'}"`
      );
      expect(html).toContain('id="page-content"');
      expect(at(html, 'page-cover-caption')).toBeLessThan(at(html, 'class="lead"'));
      expect(at(html, 'class="lead"')).toBeLessThan(at(html, 'page-meta'));
      expect(html).not.toMatch(/\sstyle=|<style|<script/);
    });

    it(`a cover without a hero image falls back to standard in ${locale}`, async () => {
      const html = await page(locale, 'default', undefined, { header: 'cover', hero: false });
      expect(html).not.toContain('page-cover');
      expect(html).toContain('page-rule');
    });
  }

  it('has no meta line without anything to say, and leaves out what is missing', () => {
    expect(renderMeta({ publishedAt: null, authors: [], section: null }, 'nl', 'UTC')).toBeNull();
    expect(renderMeta({ publishedAt: null, authors: ['A'], section: null }, 'nl', 'UTC')).toEqual({
      date: null,
      byline: 'door A',
      section: null,
    });
  });

  it('keeps a name as text: `$&` in it is no replacement pattern', () => {
    const name = 'Sam $& $` Vries';
    const meta = renderMeta({ publishedAt: null, authors: [name], section: null }, 'nl', 'UTC');
    expect(meta?.byline).toBe(`door ${name}`);
    const { body } = render(Credit, {
      props: { credit: { work: null, photographer: name }, photographer: 'Foto: {name}' },
    });
    expect(body).toContain('Foto: Sam $&amp; $` Vries');
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
