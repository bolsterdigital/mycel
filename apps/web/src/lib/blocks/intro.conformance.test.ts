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
import { renderMarkdown } from './markdown.js';
import { placeRecording } from './recording.js';
import {
  renderCorrections,
  renderEvent,
  renderMeta,
  resolveDocument,
  resolveIntro,
  type ResolveSource,
} from './resolve.js';

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

const VIDEO = '01900000-0000-7000-8000-000000000305';
const source: ResolveSource = {
  form: async () => null,
  media: async (id) => (id === HERO ? hero : null),
  itemPath: async () => null,
  // A playable recording with a transcript of two voices, a sound and a line past the hour, and
  // two chapters (MY-305 PR 2).
  video: async (id, locale) =>
    id === VIDEO
      ? {
          metadata: {
            title: { nl: 'Het gesprek', en: 'The conversation' },
            maker: 'Mycel',
            licence: { code: 'cc0' },
            watchUrl: null,
          },
          duration: 2455,
          posterId: HERO,
          playable: true,
          origin: 'https://tenant.b-cdn.net',
          transcript: [
            { start: 0, end: 2.5, text: '[muziek]', speaker: null },
            {
              start: 190,
              end: 196.4,
              text: locale === 'en' ? 'Welcome to the square.' : 'Welkom op het plein.',
              speaker: 'Sam de Vries',
            },
            {
              start: 3723.25,
              end: 3725,
              text: locale === 'en' ? 'Thanks.' : 'Dank.',
              speaker: 'Noor',
            },
          ],
          transcriptText: [],
          chapters: [
            { start: 0, end: 190, title: locale === 'en' ? 'Opening' : 'Opening' },
            {
              start: 190,
              end: 2455,
              title: locale === 'en' ? 'On the square' : 'Op het plein',
            },
          ],
        }
      : null,
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
  head: {
    header?: 'standard' | 'cover' | 'split';
    action?: Parameters<typeof resolveIntro>[1]['action'];
    view?: Parameters<typeof resolveIntro>[1]['view'];
    hero?: boolean;
    meta?: boolean;
    event?: boolean;
    corrections?: { date: string; text: string }[];
    /** The media profile: a recording before the body, lifted into the header. */
    recording?: boolean;
  } = {}
) {
  const doc = head.recording
    ? {
        ...article,
        blocks: [
          Block.parse({ id: 'film', type: 'video', version: 1, props: { videoId: VIDEO } }),
          ...article.blocks,
        ],
      }
    : article;
  const resolved = await resolveDocument(
    source,
    { locale, ...projectDocument(doc, locale) },
    {
      base: '',
      fallbackLocale: 'nl',
      ...(head.recording ? { videoRoute: `/_video/${locale}/article/drie-jaar` } : {}),
    }
  );
  const header = await resolveIntro(
    source,
    {
      lead: article.lead?.[locale] ?? null,
      heroImageId: head.hero === false ? null : effectiveImages(article).hero.mediaId,
      heroAlt: heroAlt?.[locale] ?? null,
      ...(head.header ? { header: head.header } : {}),
      ...(head.view ? { view: head.view } : {}),
      ...(head.action ? { action: head.action } : {}),
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
      ...(head.event
        ? {
            event: renderEvent(
              {
                startsAt: '2026-12-05T20:00',
                endsAt: '2026-12-05T22:00',
                location:
                  locale === 'nl' ? 'Buurthuis, Kerkstraat 1' : 'Community centre, Kerkstraat 1',
                onlineUrl: 'https://example.org/live',
              },
              locale
            ),
          }
        : {}),
    },
    locale
  );
  const { intro, model } = placeRecording(header, resolved, head.view);
  const data = {
    view: 'item' as const,
    model,
    intro,
    corrections: renderCorrections(head.corrections, locale),
    dropCap: resolveTheme(THEMES[theme]).dropCap === 'articles',
    head: {
      canonical: '/',
      alternates: [],
      description: null,
      share: { title: model.title, type: 'article' as const },
      image: null,
    },
    embeds: [],
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

it('keeps an ordinary first letter until measurement, and respects the site choice without an image', async () => {
  const view = { header: 'cover' as const, portraits: true, minutes: 1, initial: true };
  const options = { view, header: view.header, hero: false, meta: true };
  const on = await page('nl', 'default', undefined, options);
  expect(on).toContain('data-measure-initial');
  expect(on).not.toContain('data-drop-cap');
  expect(on).not.toContain('page-cover');
  expect(on).toContain('1 min lezen');
  const off = await page('en', 'editorial-off', undefined, options);
  expect(off).not.toMatch(/data-(measure-initial|drop-cap)/);
  expect(off).toContain('1 min read');
});

describe('the split page header (ADR 025, amended 2026-11-23)', () => {
  const join = { label: 'Word actief', target: { kind: 'url' as const, url: '/doe-mee' } };

  it('puts title, lead and one button in a panel before the image', async () => {
    const html = await page('nl', 'default', undefined, { header: 'split', action: join });
    expect(html).toMatch(/<header class="page-split">\s*<div class="page-split-panel">\s*<h1/);
    expect(html.match(/<h1/g)).toHaveLength(1);
    const at = (needle: string) => html.indexOf(needle);
    expect(at('page-split-panel')).toBeLessThan(at('class="lead"'));
    expect(at('class="lead"')).toBeLessThan(at('class="button" href="/doe-mee"'));
    expect(at('class="button"')).toBeLessThan(at('page-split-media'));
    expect(html).toMatch(/<div class="page-split-media">\s*<picture/);
    expect(html).not.toContain('page-hero');
    expect(html).not.toMatch(/\sstyle=|<style|<script/);
  });

  it('shows no button without one, or when its item is no longer published', async () => {
    const none = await page('nl', 'default', undefined, { header: 'split' });
    expect(none).toContain('page-split-panel');
    expect(none).not.toContain('class="actions"');
    const gone = await page('nl', 'default', undefined, {
      header: 'split',
      action: {
        label: 'Lees',
        target: { kind: 'item', itemId: '0190f1a0-0000-7000-8000-000000000001' },
      },
    });
    expect(gone).not.toContain('class="button"');
  });

  it('falls back to the standard header without a hero image', async () => {
    const html = await page('nl', 'default', undefined, {
      header: 'split',
      action: join,
      hero: false,
    });
    expect(html).not.toContain('page-split');
    expect(html).not.toContain('Word actief');
    expect(html).toContain('page-rule');
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
      props: {
        credit: { work: null, photographer: name },
        words: {
          photo: 'Foto: {name}',
          illustration: 'Illustratie: {name}',
          other: 'Beeld: {name}',
        },
      },
    });
    expect(body).toContain('Sam $&amp; $` Vries');
    expect(body).toContain('<span class="credit-word">Foto: </span>');
  });
});

describe('the media header (ADR 025, amended 2026-11-27)', () => {
  const at = (html: string, s: string) => html.indexOf(s);
  const view = {
    header: 'standard' as const,
    portraits: false,
    minutes: 1,
    initial: false,
    video: { blockId: 'film', duration: true },
  };
  for (const locale of ['nl', 'en'] as const)
    it(`puts the recording and its transcript between the lead and the meta line in ${locale}`, async () => {
      const html = await page(locale, 'default', undefined, { view, meta: true, recording: true });
      await expect(html).toMatchFileSnapshot(`__snapshots__/item-intro-media.${locale}.html`);
      // Title, lead, player, read-along, meta line, then the body without the recording.
      expect(at(html, '<h1')).toBeLessThan(at(html, 'class="lead"'));
      expect(at(html, 'class="lead"')).toBeLessThan(at(html, 'media-stage'));
      expect(at(html, 'data-managed-video')).toBeLessThan(at(html, 'read-along'));
      expect(at(html, 'read-along')).toBeLessThan(at(html, 'page-meta'));
      expect(at(html, 'page-meta')).toBeLessThan(at(html, 'rich-text'));
      expect(html.match(/data-managed-video/g)).toHaveLength(1);
      expect(html).toContain('id="block-film"');
      // The poster is the header's image: no hero, and it loads first.
      expect(html).not.toContain('page-hero');
      expect(html).toContain('fetchpriority="high"');
      expect(html).not.toContain('loading="lazy"');
      // The duration replaces the reading time; each line shows its start and its speaker.
      expect(html).toContain('<span>41 min</span>');
      expect(html).not.toMatch(/min (lezen|read)/);
      expect(html).toMatch(/<time datetime="PT3M10S">3:10<\/time>/);
      expect(html).toMatch(/<time datetime="PT62M3S">1:02:03<\/time>/);
      expect(html).toContain('<span class="read-along-speaker">Sam de Vries</span>');
      expect(html).not.toContain('<details');
      expect(html).toContain(locale === 'nl' ? '>Lees mee</h2>' : '>Read along</h2>');
      // What only works with the script is hidden until it runs; nothing styled inline.
      expect(html).toMatch(/class="media-controls" data-media-controls="" hidden/);
      expect(html).toMatch(/class="read-along-search" data-read-along-search="" hidden/);
      expect(html).toMatch(/class="read-along-find" data-read-along-find="" hidden/);
      expect(html).toMatch(/class="media-undock" data-undock="" hidden/);
      expect(html).not.toMatch(/\sstyle=|<style/);
      // The search keeps a label of its own beside its placeholder.
      expect(html).toMatch(/<label class="read-along-label" for="read-along-film-query">/);
      // Under the player first its controls, then the chapters: a list of starts and titles that
      // the script turns into buttons; nothing hidden, since the list reads without it.
      expect(at(html, 'data-managed-video')).toBeLessThan(at(html, 'data-media-controls'));
      expect(at(html, 'data-media-controls')).toBeLessThan(at(html, 'data-chapters'));
      expect(html).toContain(locale === 'nl' ? '>Hoofdstukken</h2>' : '>Chapters</h2>');
      expect(html).toMatch(
        new RegExp(
          '<li data-start="190">\\s*<time datetime="PT3M10S">3:10</time>\\s*<span class="media-chapter-title">' +
            (locale === 'nl' ? 'Op het plein' : 'On the square')
        )
      );
    });

  it('falls back to the Post header when the recording is not on the page', async () => {
    const html = await page('nl', 'default', undefined, { view, meta: true });
    expect(html).toContain('page-hero');
    expect(html).toContain('1 min lezen');
    expect(html).not.toContain('media-stage');
  });

  it('keeps the recording in the Markdown, where the editor put it', async () => {
    const markdownSource = await resolveDocument(
      source,
      {
        locale: 'nl',
        ...projectDocument(
          {
            ...article,
            blocks: [
              Block.parse({ id: 'film', type: 'video', version: 1, props: { videoId: VIDEO } }),
            ],
          },
          'nl'
        ),
      },
      { base: '', fallbackLocale: 'nl', videoRoute: '/_video/nl/article/drie-jaar' }
    );
    const placed = placeRecording(
      {
        lead: null,
        hero: null,
        header: 'standard',
        article: { portraits: false, initial: false, readingTime: null, authors: [] },
        meta: null,
      },
      markdownSource,
      view
    );
    expect(placed.model.lifted).toBe('film');
    expect(
      renderMarkdown(placed.model, {
        canonicalUrl: 'https://x.test/a',
        siteRoot: 'https://x.test',
        lead: null,
        corrections: null,
        gate: null,
      })
    ).toBe(
      renderMarkdown(markdownSource, {
        canonicalUrl: 'https://x.test/a',
        siteRoot: 'https://x.test',
        lead: null,
        corrections: null,
        gate: null,
      })
    );
  });
});

describe('an event page’s when and where', () => {
  const at = (html: string, s: string) => html.indexOf(s);
  for (const locale of ['nl', 'en'] as const)
    it(`shows the date, place and online address under the lead in ${locale}`, async () => {
      const html = await page(locale, 'default', undefined, { event: true });
      await expect(html).toMatchFileSnapshot(`__snapshots__/item-intro-event.${locale}.html`);
      expect(at(html, 'class="lead"')).toBeLessThan(at(html, 'page-event'));
      expect(at(html, 'page-event')).toBeLessThan(at(html, 'page-hero'));
      // The wall clock as entered, one day named once, no zone shift.
      expect(html).toContain('datetime="2026-12-05T20:00"');
      expect(html).toContain(
        locale === 'nl' ? 'zaterdag 5 december 2026, 20:00–22:00' : 'Saturday, December 5, 2026'
      );
      expect(html).toContain(locale === 'nl' ? 'Buurthuis' : 'Community centre');
      expect(html).toContain('href="https://example.org/live"');
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

describe('an article’s corrections (ADR 012 rule 1)', () => {
  const at = (html: string, s: string) => html.indexOf(s);
  const corrections = {
    nl: [
      { date: '2026-11-01', text: 'Een eerdere versie noemde het verkeerde jaartal.' },
      { date: '2026-11-03', text: 'De naam van de wethouder is hersteld.' },
    ],
    en: [{ date: '2026-11-01', text: 'An earlier version gave the wrong year.' }],
  };
  for (const locale of ['nl', 'en'] as const)
    it(`shows dated notes in their own section after the body in ${locale}`, async () => {
      const html = await page(locale, 'default', undefined, {
        corrections: corrections[locale],
      });
      await expect(html).toMatchFileSnapshot(`__snapshots__/item-corrections.${locale}.html`);
      expect(at(html, 'rich-text')).toBeLessThan(at(html, 'page-corrections'));
      expect(html).toMatch(
        /<section[^>]*aria-labelledby="page-corrections"[^>]*>\s*<h2 id="page-corrections">/
      );
      expect(html).toContain(locale === 'nl' ? '>Correcties</h2>' : '>Corrections</h2>');
      expect(html).toContain('datetime="2026-11-01"');
      expect(html).toContain(locale === 'nl' ? '1 november 2026' : 'November 1, 2026');
      expect(html.match(/<li>/g)).toHaveLength(corrections[locale].length);
    });

  it('ends the Markdown with the same section, escaped', async () => {
    const model = await resolveDocument(
      source,
      { locale: 'nl', ...projectDocument(article, 'nl') },
      { base: '', fallbackLocale: 'nl' }
    );
    const markdown = renderMarkdown(model, {
      canonicalUrl: 'https://example.org/x',
      siteRoot: 'https://example.org',
      corrections: renderCorrections([{ date: '2026-11-01', text: 'Jaartal *hersteld*.' }], 'nl'),
    });
    expect(markdown.endsWith('## Correcties\n\n- 1 november 2026: Jaartal \\*hersteld\\*.\n')).toBe(
      true
    );
  });

  it('has no section without corrections', async () => {
    expect(renderCorrections([], 'nl')).toBeNull();
    expect(renderCorrections(undefined, 'nl')).toBeNull();
    expect(await page('nl', 'default')).not.toContain('page-corrections');
  });
});
