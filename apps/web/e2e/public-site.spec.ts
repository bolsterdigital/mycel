// flow: publish
// What a visitor gets from a published site: composed block pages, the route grammar with its
// head and caching, grid compositions, and a site's chrome and theme from its settings. Each part
// below was a spec of its own until TODO #50 folded the suite to its budget (testing.md
// § End-to-end flows); each keeps its own fixtures.

import { exercisePeopleGrid } from './lib/people/grid';
import { exercisePublicPeople } from './lib/people/public';
import { openPublication, closePublication } from './lib/publication';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ContentDocument,
  DEFAULT_THEME,
  THEME_PRESETS,
  contrastRatio,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { type APIRequestContext, type Page, chromium, expect, test } from '@playwright/test';
import sharp from 'sharp';
import { expectNoAxeViolations } from './lib/axe';
import { editorReady } from './lib/editor';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize, setTextSpacing } from './lib/layout';
import { login } from './lib/login';
import { OTHER_SCRIPTS, isA11y, onlyA11y } from './lib/project';
import { callApi, requireApi } from './lib/api';
import { themeCss } from '../src/lib/theme/tokens';

// The block renderer on two composed pages (TODO #8c1, brief #8c § 5), seeded by scripts/e2e/e2e.mjs
// from the registry's own examples: `campagne` (hero cover, rich text, cta card, wide image, FAQ
// accordion, form card) and `artikel` (hero split, rich text with headings and a footnote,
// pullquote, floated image, warning callout, video link), each in nl and en. Per page and
// locale: axe clean, readable and usable without JavaScript, no script at all, fonts and images
// from the site's own origin, no CSP violation. Then one run each with reduced motion and the
// dark palette. Both pages are routes of the generic UI gate (routes.ts).
test.describe('blocks', () => {
  const PAGES = {
    campagne: { nl: 'Schone lucht, nu', en: 'Clean air, now' },
    artikel: { nl: 'Een straat vol bomen', en: 'A street full of trees' },
  } as const;
  /**
   * Which fixture pages use italic in their body text. The italic face is preloaded at low
   * priority only there (theme/tokens.ts `withItalicPreload`); an exact count per page catches
   * both a missing hint and one that leaks onto pages without italic.
   */
  const ITALIC: Record<keyof typeof PAGES, boolean> = { campagne: false, artikel: true };

  test.use({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

  /** Opens a page and records requests to other origins and CSP reports in the console. */
  async function open(page: Page, path: string) {
    const foreign: string[] = [];
    const csp: string[] = [];
    const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173').origin;
    page.on('request', (r) => {
      if (new URL(r.url()).origin !== origin) foreign.push(r.url());
    });
    page.on('console', (m) => {
      if (/Content.Security.Policy/i.test(m.text())) csp.push(m.text());
    });
    const response = await page.goto(path, { waitUntil: 'load' });
    expect(response?.status()).toBe(200);
    return { foreign, csp };
  }

  for (const [slug, titles] of Object.entries(PAGES))
    for (const locale of ['nl', 'en'] as const)
      test.describe(`${slug} in ${locale}`, () => {
        test.use({ locale: locale === 'nl' ? 'nl-NL' : 'en-GB' });

        test('renders every block, ships no script and passes axe', async ({ page }) => {
          // The locale is the path's (TODO #8c2), whatever the browser asks for.
          const { foreign, csp } = await open(
            page,
            locale === 'nl' ? `/probe/${slug}` : `/probe/en/${slug}`
          );
          await expect(page.locator('html')).toHaveAttribute('lang', locale);
          await expect(page.getByRole('heading', { level: 1 })).toHaveText(titles[locale]);
          expect(await page.locator('h1').count()).toBe(1);
          // ADR 009 rule 4: no client JavaScript on a content page.
          // Only the enhancement modules of lib/project.ts.
          expect(await page.locator(OTHER_SCRIPTS).count()).toBe(0);
          expect(await page.locator('[style]').count()).toBe(0);
          // Every image is sized and comes from the site; the theme is a linked stylesheet.
          for (const img of await page.locator('main img').all()) {
            await expect(img).toHaveAttribute('width', /\d+/);
            await expect(img).toHaveAttribute('height', /\d+/);
            await expect(img).toHaveAttribute('alt', /.*/);
          }
          await expect(page.locator('link[rel="stylesheet"][href*="/_theme/"]')).toHaveCount(1);
          await expect(
            page.locator('link[rel="preload"][as="font"][href$="-roman.woff2"]')
          ).toHaveCount(1);
          const italic = page.locator('link[rel="preload"][as="font"][href$="-italic.woff2"]');
          if (ITALIC[slug as keyof typeof PAGES]) {
            await expect(italic).toHaveCount(1);
            await expect(italic).toHaveAttribute('fetchpriority', 'low');
          } else {
            await expect(italic).toHaveCount(0);
          }
          await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(
            ITALIC[slug as keyof typeof PAGES] ? 2 : 1
          );
          if (isA11y()) {
            // Images actually load (the media route serves the seeded variants), fonts are ours.
            await page.evaluate(() => document.fonts.ready);
            for (const img of await page.locator('main img').all()) {
              await img.scrollIntoViewIfNeeded();
              await expect
                .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth))
                .toBeGreaterThan(0);
            }
            expect(
              await page.evaluate(() =>
                [...document.fonts].some((f) => f.family.includes('Inter') && f.status === 'loaded')
              )
            ).toBe(true);
            await expectNoAxeViolations(page);
          }
          expect(foreign).toEqual([]);
          expect(csp).toEqual([]);
        });
      });

  test('the theme stylesheet is immutable under its hash and redirects stale hashes without caching', async ({
    page,
    request,
  }) => {
    await open(page, '/probe/campagne');
    const href = await page
      .locator('link[rel="stylesheet"][href*="/_theme/"]')
      .getAttribute('href');
    expect(href).toMatch(/^\/probe\/_theme\/[0-9a-f]{16}\.css$/);
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/css');
    expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(await res.text()).toContain('--color-body-bg:');
    const staleHash = href!.includes('/0000000000000000.css')
      ? 'ffffffffffffffff'
      : '0000000000000000';
    const stale = await request.get(`/probe/_theme/${staleHash}.css`, { maxRedirects: 0 });
    expect(stale.status()).toBe(302);
    expect(stale.headers()['location']).toBe(href);
    expect(stale.headers()['cache-control']).toBe('no-store');
    const redirected = await request.get(`/probe/_theme/${staleHash}.css`);
    expect(redirected.status()).toBe(200);
    expect(redirected.url()).toContain(href!);
    expect(redirected.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(await redirected.text()).toBe(await res.text());
    expect((await request.get('/probe/_theme/not-a-hash.css')).status()).toBe(404);
  });

  test.describe('without JavaScript', () => {
    test.use({ locale: 'nl-NL' });

    test('the FAQ accordion opens and closes, links and the form are plain HTML', async ({
      page,
    }) => {
      await open(page, '/probe/campagne');
      const details = page.locator('details').first();
      await expect(details).not.toHaveAttribute('open', '');
      await details.locator('summary').click();
      await expect(details).toHaveAttribute('open', '');
      await expect(details.getByText('Op zaterdag.')).toBeVisible();
      await details.locator('summary').click();
      await expect(details).not.toHaveAttribute('open', '');
      await expect(page.locator('form[method="post"] button[type="submit"]')).toHaveText(
        'Aanmelden'
      );
      await expect(page.getByRole('link', { name: 'Teken de petitie' }).first()).toHaveAttribute(
        'href',
        '/probe/signup'
      );
    });

    // The accordion as the Dreamkit FAQ (brief 46C-2): Tab reaches the question, Enter and Space
    // open and close it natively in both projects, axe passes open and closed, and at 320 CSS px
    // and 200% text a question wraps inside its bar with the icon column still beside it. The
    // registry example with the longest question stands alone, so the page gate measures the FAQ.
    test('the FAQ accordion works from the keyboard and stays whole at 320 px and 200% text', async ({
      page,
    }) => {
      await page.setViewportSize(NARROW);
      await open(page, '/probe/blok-faq-accordion-full');
      const details = page.locator('.faq-accordion details').first();
      const summary = details.locator('summary');
      await expect(details).toHaveAttribute('name', /^faq-/);
      for (let i = 0; i < 60 && !(await summary.evaluate((s) => s === document.activeElement)); i++)
        await page.keyboard.press('Tab');
      await expect(summary).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('open', '');
      await expect(details.locator('.answer')).toBeVisible();
      await page.keyboard.press('Space');
      await expect(details).not.toHaveAttribute('open', '');
      await expectNoAxeViolations(page, { dark: true });
      await page.keyboard.press('Space');
      await expect(details.locator('.answer')).toBeVisible();
      await expectNoAxeViolations(page, { dark: true });
      for (const text of ['100%', '200%']) {
        await setTextSize(page, text);
        await layoutGate(page, `FAQ at 320 px and ${text} text`, '.faq');
        const bar = await summary.evaluate((s) => {
          const box = s.getBoundingClientRect();
          const question = s.firstElementChild!.getBoundingClientRect();
          return { height: box.height, room: box.right - question.right };
        });
        expect(bar.height).toBeGreaterThanOrEqual(44);
        // The icon column (1.25rem plus its gap) stays to the right of the question.
        expect(bar.room).toBeGreaterThanOrEqual(20);
      }
    });

    for (const locale of ['nl', 'en'])
      for (const [name, theme] of Object.entries({ default: DEFAULT_THEME, ...THEME_PRESETS }))
        for (const variant of ['card', 'band'])
          test(`public action colours ${variant}/${name}/${locale} stay readable through hover and focus transitions`, async ({
            page,
          }) => {
            onlyA11y('computed colours and actual CSS transitions');
            await page.setViewportSize(NARROW);
            await open(
              page,
              `/probe/${locale === 'en' ? 'en/' : ''}${variant === 'card' ? 'campagne' : 'blok-cta-band'}`
            );
            await setTextSize(page, '200%');
            const sheet = await page.evaluateHandle(() => {
              const sheet = new CSSStyleSheet();
              document.adoptedStyleSheets.push(sheet);
              return sheet;
            });
            await sheet.evaluate((sheet, css) => sheet.replaceSync(css), themeCss(theme));
            for (const colorScheme of ['light', 'dark'] as const) {
              await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
              for (const selector of [
                '.cta .button:not(.secondary)',
                ...(variant === 'card' ? ['.cta .button.secondary', '.faq-accordion summary'] : []),
              ]) {
                const action = page.locator(selector).first();
                await action.scrollIntoViewIfNeeded();
                await page.mouse.move(0, 0);
                await action.evaluate(async (el) => {
                  (el as HTMLElement).blur();
                  await Promise.all(el.getAnimations().map((a) => a.finished));
                });
                const before = await action.evaluate((el) => {
                  const css = getComputedStyle(el);
                  return [css.color, css.backgroundColor];
                });
                // Pause at transition start, so a busy runner cannot finish the 150 ms fade
                // before the test reads it. No product duration or wall-clock wait is changed.
                await action.evaluate((el) =>
                  el.addEventListener(
                    'transitionrun',
                    () => {
                      for (const animation of el.getAnimations()) animation.pause();
                    },
                    { once: true }
                  )
                );
                await action.hover();
                const samples = await action.evaluate(async (el) => {
                  const animations = el.getAnimations();
                  await Promise.all(animations.map((a) => a.ready));
                  for (const a of animations) a.pause();
                  const canvas = document.createElement('canvas');
                  canvas.width = canvas.height = 1;
                  const ctx = canvas.getContext('2d')!;
                  const hex = (colour: string) => {
                    ctx.fillStyle = colour;
                    ctx.fillRect(0, 0, 1, 1);
                    return (
                      '#' +
                      [...ctx.getImageData(0, 0, 1, 1).data]
                        .slice(0, 3)
                        .map((n) => n.toString(16).padStart(2, '0'))
                        .join('')
                    );
                  };
                  return [0, 0.25, 0.5, 0.75, 1].map((fraction) => {
                    for (const a of animations)
                      a.currentTime = Number(a.effect!.getTiming().duration) * fraction;
                    const css = getComputedStyle(el);
                    return {
                      fg: css.color,
                      bg: css.backgroundColor,
                      fgHex: hex(css.color),
                      bgHex: hex(css.backgroundColor),
                      decoration: css.textDecorationLine,
                      animations: animations.length,
                    };
                  });
                });
                expect(samples[0]!.animations, `${name}/${colorScheme}/${selector}`).toBe(1);
                expect([samples[4]!.fg, samples[4]!.bg]).not.toEqual(before);
                for (const sample of samples) {
                  expect(
                    contrastRatio(sample.fgHex, sample.bgHex),
                    `${name}/${colorScheme}/${selector}`
                  ).toBeGreaterThanOrEqual(4.5);
                  if (selector.includes('button')) expect(sample.decoration).toBe('none');
                }
                await action.evaluate((el) => {
                  for (const a of el.getAnimations()) a.finish();
                });
                await page.mouse.move(0, 0);
                await action.evaluate(async (el) => {
                  await Promise.all(el.getAnimations().map((a) => a.finished));
                });
                await action.focus();
                await action.evaluate(async (el) => {
                  await Promise.all(el.getAnimations().map((a) => a.finished));
                });
                const focused = await action.evaluate((el) => {
                  const css = getComputedStyle(el);
                  return {
                    fg: css.color,
                    bg: css.backgroundColor,
                    outline: css.outlineStyle,
                    width: css.outlineWidth,
                  };
                });
                expect([focused.fg, focused.bg]).toEqual([samples[4]!.fg, samples[4]!.bg]);
                expect(focused.outline).not.toBe('none');
                expect(parseFloat(focused.width)).toBeGreaterThanOrEqual(3);
                await action.evaluate((el) => (el as HTMLElement).blur());
              }
              await page.emulateMedia({ reducedMotion: 'reduce' });
              for (const selector of [
                '.cta .button',
                ...(variant === 'card' ? ['.faq-accordion summary'] : []),
              ])
                expect(
                  await page
                    .locator(selector)
                    .first()
                    .evaluate((el) => getComputedStyle(el).transitionDuration)
                ).toBe('0s');
              await layoutGate(
                page,
                `${name}/${colorScheme}/${locale} actions at 320/200%`,
                '.cta'
              );
              await expectNoAxeViolations(page);
            }
            await page.screenshot({
              path: test
                .info()
                .outputPath(`public-polish-${variant}-${name}-${locale}-320-200.png`),
              fullPage: true,
            });
          });

    test('the article keeps its outline and its footnote', async ({ page }) => {
      await open(page, '/probe/artikel');
      const levels = await page
        .locator('main :is(h1,h2,h3,h4,h5,h6)')
        .evaluateAll((hs) => hs.map((h) => Number(h.tagName.slice(1))));
      expect(levels[0]).toBe(1);
      for (let i = 1; i < levels.length; i++)
        expect(levels[i]!).toBeLessThanOrEqual(levels[i - 1]! + 1);
      await expect(page.locator('sup a[href^="#fn-"]')).toHaveCount(1);
      await expect(page.getByRole('link', { name: 'Interview met de wethouder' })).toHaveAttribute(
        'href',
        'https://vimeo.com/76979871'
      );
    });
  });

  test.describe('user preferences', () => {
    test.use({ locale: 'nl-NL' });

    test('reduced motion turns every transition off', async ({ page }) => {
      onlyA11y('reads computed styles with a script');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await open(page, '/probe/campagne');
      const moving = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
          .filter((el) => {
            const s = getComputedStyle(el);
            return (
              s.transitionDuration.split(',').some((d) => parseFloat(d) > 0) ||
              s.animationName !== 'none'
            );
          })
          .map((el) => el.className || el.tagName)
      );
      expect(moving).toEqual([]);
    });

    test('the dark palette passes axe on both pages', async ({ page }) => {
      onlyA11y('axe runs as a script');
      await page.emulateMedia({ colorScheme: 'dark' });
      for (const slug of Object.keys(PAGES)) {
        await open(page, `/probe/${slug}`);
        expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
          'rgb(22, 22, 26)'
        );
        await expectNoAxeViolations(page);
      }
    });
  });
});

// The route grammar, head and caching of a site (TODO #8c2, brief #8c § 8–10), on the dev path
// form and against the real stack: the locale is the path (no prefix for the default, a 404 for
// the default with one), articles live under `/articles/`, every page names its canonical URL
// and its published translations, published HTML is publicly cacheable with a strong ETag and a
// 304, no cookie is set, and misses are `no-store`. Then the JSON read route of the API process
// on the same seeded article.
// Sends the edit form as it stands to the unsaved-document route, as the live-preview panel does.
// An article has no panel yet (#11), so its specs post the unchanged native form themselves.
async function postDraftPreview(page: Page, itemId: string) {
  await page.locator('[data-live-preview-source]').evaluate((node, id) => {
    const form = node as HTMLFormElement;
    form.action = '/admin/probe/preview/draft';
    for (const [name, value] of [
      ['itemId', id],
      ['previewLocale', 'nl'],
    ]) {
      const input = document.createElement('input');
      input.name = name!;
      input.value = value!;
      form.append(input);
    }
    form.submit();
  }, itemId);
}

test.describe('content-routes', () => {
  /** The canonical address form: the seed gives tenant probe this primary hostname. */
  const SITE = 'http://probe.localhost:4173';
  const ARTICLE = 'bomen-in-de-straat';

  test.use({ locale: 'nl-NL', extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

  const head = (page: Page) =>
    page.evaluate(() => ({
      canonical: document.querySelector('link[rel=canonical]')?.getAttribute('href'),
      alternates: [...document.querySelectorAll('link[rel=alternate][hreflang]')].map((l) => [
        l.getAttribute('hreflang'),
        l.getAttribute('href'),
      ]),
      description: document.querySelector('meta[name=description]')?.getAttribute('content'),
    }));

  test('a page names its canonical URL and every published translation', async ({ page }) => {
    await page.goto('/probe/en/campagne');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Clean air, now');
    expect(await head(page)).toMatchObject({
      canonical: `${SITE}/en/campagne`,
      alternates: [
        ['nl', `${SITE}/campagne`],
        ['en', `${SITE}/en/campagne`],
        ['x-default', `${SITE}/campagne`],
      ],
    });
    // The footer credit follows the path too, not the Dutch browser.
    await expect(page.getByRole('contentinfo').getByRole('link')).toHaveText('Runs on Mycel');

    // A Dutch-only page lists itself and nothing else.
    await page.goto('/probe/draft-check');
    expect((await head(page)).alternates).toEqual([
      ['nl', `${SITE}/draft-check`],
      ['x-default', `${SITE}/draft-check`],
    ]);
  });

  test('an article lives under /articles/, in each published locale', async ({ page, request }) => {
    await page.goto(`/probe/articles/${ARTICLE}`);
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Bomen in de straat');
    expect(await head(page)).toMatchObject({
      canonical: `${SITE}/articles/${ARTICLE}`,
      description: 'Waarom de buurt meer groen wil.',
    });
    await expectNoAxeViolations(page);

    await page.goto(`/probe/en/articles/${ARTICLE}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trees in the street');
    // An article is not a page, and the list roots wait for #9.
    for (const path of [`/probe/${ARTICLE}`, '/probe/articles', '/probe/index'])
      expect((await request.get(path)).status(), path).toBe(404);
  });

  test('the default locale has no prefix; an unknown or default prefix is a no-store 404', async ({
    request,
  }) => {
    for (const path of ['/probe/nl/campagne', '/probe/de/campagne', '/probe/en/nothing-here']) {
      const res = await request.get(path);
      expect(res.status(), path).toBe(404);
      expect(res.headers()['cache-control'], path).toBe('no-store');
    }
  });

  test('a missing page says so in the language of its address, inside the site', async ({
    page,
  }) => {
    for (const [path, lang, title, home] of [
      ['/probe/nothing-here', 'nl', 'Pagina niet gevonden', 'Naar de homepage'],
      ['/probe/en/nothing-here', 'en', 'Page not found', 'Go to the home page'],
    ] as const) {
      expect((await page.goto(path))?.status(), path).toBe(404);
      await expect(page.locator('html'), path).toHaveAttribute('lang', lang);
      await expect(page.getByRole('heading', { level: 1, name: title }), path).toBeVisible();
      await expect(page, path).toHaveTitle(new RegExp(`^${title} · `));
      await expect(page.locator('.site-header'), path).toBeVisible();
      await expect(page.getByRole('main').getByRole('link', { name: home }), path).toBeVisible();
      await expectNoAxeViolations(page);
    }
  });

  test('published HTML is publicly cacheable, revalidates to a 304 and sets no cookie', async ({
    request,
  }) => {
    // An item without a form: the campaign page renders one and is `no-store` (#30A, signup.spec).
    const path = `/probe/articles/${ARTICLE}`;
    const first = await request.get(path);
    expect(first.status()).toBe(200);
    const headers = first.headers();
    expect(headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=600');
    expect(headers['etag']).toMatch(/^"[0-9a-f-]{36}:nl:[0-9a-f]{16}:[\w-]{16}"$/);
    expect(headers['set-cookie']).toBeUndefined();
    expect(headers['vary'] ?? '').not.toMatch(/cookie|accept-language/i);

    const again = await request.get(path, {
      headers: { 'if-none-match': headers['etag']! },
    });
    expect(again.status()).toBe(304);
    expect(await again.body()).toHaveLength(0);
    expect(again.headers()['etag']).toBe(headers['etag']);

    const english = await request.get(`/probe/en/articles/${ARTICLE}`);
    expect(english.headers()['etag']).not.toBe(headers['etag']);
    expect(
      (await request.get(path, { headers: { 'accept-language': 'en' } })).headers()['etag']
    ).toBe(headers['etag']);
  });

  test('a form post keeps its locale on the way to a no-store thank-you page', async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto('/probe/en/signup');
    const formId = await page.locator('input[name="formId"]').inputValue();
    const started = await page.locator('input[name="_started"]').inputValue();
    // A tripped honeypot gets the person's redirect (bots learn nothing), without the timing wait.
    const post = await request.post('/probe/en/signup', {
      headers: {
        origin: baseURL!,
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        // The client address (ADDRESS_HEADER in playwright.config.ts), a fresh rate-limit bucket.
        'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
      },
      data: new URLSearchParams({
        formId,
        _started: started,
        email: 'bot@example.org',
        website: 'x',
      }).toString(),
      maxRedirects: 0,
    });
    expect(post.status()).toBe(303);
    expect(post.headers()['location']).toBe('/probe/en/signup/thanks');
    const thanks = await request.get('/probe/en/signup/thanks');
    expect(thanks.status()).toBe(200);
    expect(thanks.headers()['cache-control']).toBe('no-store');
  });

  test('an article shows its lead, hero and drop cap, whole at 320 px and 200% text (#86)', async ({
    page,
    request,
  }) => {
    // A copy of the quality article with a lead and its first block image as hero: synthetic
    // assets that are already public and ready, never an upload.
    // One item per project: two creates of one slug at once answer 500 instead of 409.
    const slug = `e2e-intro-99-${isA11y() ? 'a11y' : 'no-js'}`;
    const { items } = await callApi(request, 'content.item.list', { type: 'article', slug });
    let target = items[0]
      ? await callApi(request, 'content.item.get', { itemId: items[0].id })
      : null;
    if (!target) {
      const [source] = (
        await callApi(request, 'content.item.list', { type: 'article', slug: 'quality-article-v3' })
      ).items;
      const { revision } = await callApi(request, 'content.item.get', { itemId: source.id });
      const doc: ContentDocument = structuredClone(revision.document);
      const image = doc.blocks.find((b) => b.type === 'image');
      expect(image, 'the quality article has an image block').toBeTruthy();
      doc.lead = { nl: 'Een straat die ruimte maakt.', en: 'A street that makes room.' };
      doc.heroImageId = (image!.props as { mediaId: string }).mediaId;
      // A described hero (#99): its alt in the locale on screen.
      doc.heroAlt = { nl: 'Een straat met bomen.', en: 'A street with trees.' };
      // The quality article's text opens with a heading, which by design gets no drop cap.
      const paragraph = (text: string) => ({
        type: 'doc' as const,
        content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }],
      });
      doc.blocks.unshift({
        id: 'opening',
        type: 'rich-text',
        version: 1,
        props: { content: { nl: paragraph('Op de hoek.'), en: paragraph('On the corner.') } },
      } as ContentDocument['blocks'][number]);
      doc.locales = doc.locales.filter((l) => l === 'nl' || l === 'en');
      target = await callApi(request, 'content.item.create', { slug, document: doc });
    }
    const probe = await tenantId();
    await withInvoker(async (invoker) => {
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, systemPrincipal(probe, 'e2e'), {
          itemId: target.item.id,
          revisionId: target.revision.id,
          locale,
        });
    });

    for (const [path, lead, alt] of [
      [`/probe/articles/${slug}`, 'Een straat die ruimte maakt.', 'Een straat met bomen.'],
      [`/probe/en/articles/${slug}`, 'A street that makes room.', 'A street with trees.'],
    ] as const) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(path);
      await expect(page.locator('main > .lead')).toHaveText(lead);
      const hero = page.locator('main > figure.page-hero img');
      await expect(hero).toHaveAttribute('width', /\d+/);
      await expect(hero).not.toHaveAttribute('loading', 'lazy');
      await expect(hero).toHaveAttribute('alt', alt);
      // The drop cap is the theme's default for articles and only on the first text block.
      expect(
        await page.evaluate(() => {
          const p = document.querySelector('main[data-drop-cap] > .rich-text > p:first-child');
          const letter = p && getComputedStyle(p, '::first-letter');
          return letter && parseFloat(letter.fontSize) > parseFloat(getComputedStyle(p).fontSize);
        })
      ).toBe(true);
      if (isA11y()) await expectNoAxeViolations(page);

      await page.setViewportSize(NARROW);
      await page.goto(path);
      for (const size of ['100%', '200%'] as const) {
        await setTextSize(page, size);
        await layoutGate(page, `${path} at ${size}`, 'main');
      }
    }

    // The live preview wraps every block in `.preview-selectable`; the drop cap is there too
    // (#86 PR 2). The unsaved-document route, posted from the edit form as the composition
    // test below does, since an article has no live-preview panel yet.
    if (isA11y()) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await login(page, `/admin/probe/content/${target.item.id}`);
      // The edit screen shows the hero as described, with the alt of the locale on screen.
      // Its state stands without a click (#158); the line opens for the field.
      const heroAltLine = page.locator('[data-hero-alt]:not([data-block-alt])');
      await expect(heroAltLine.locator('summary')).toContainText('Een straat met bomen.');
      await expect(page.locator('#heroDecorative')).not.toBeChecked();
      await expect(page.locator('#heroAlt')).toHaveValue('Een straat met bomen.');
      await heroAltLine.locator('summary').click();
      await expectNoAxeViolations(page);
      await page.setViewportSize(NARROW);
      for (const size of ['100%', '200%'] as const) {
        await setTextSize(page, size);
        await layoutGate(page, `edit screen with a described hero at ${size}`, '#heroAlt');
      }
      await setTextSize(page, '100%');
      await page.setViewportSize({ width: 1280, height: 900 });
      await postDraftPreview(page, target.item.id);
      await expect(page.locator('main > .lead')).toHaveText('Een straat die ruimte maakt.');
      await expect(page.locator('main > figure.page-hero img')).toHaveAttribute(
        'alt',
        'Een straat met bomen.'
      );
      await page.waitForLoadState('load');
      expect(
        await page.evaluate(() => {
          const p = document.querySelector(
            'main[data-drop-cap] > .preview-selectable > .rich-text > p:first-child'
          );
          const letter = p && getComputedStyle(p, '::first-letter');
          return letter && parseFloat(letter.fontSize) > parseFloat(getComputedStyle(p).fontSize);
        })
      ).toBe(true);
    }
  });

  /** An article in nl and en with a hero image, and the steps of its edit screen. */
  const heroAltArticle = async (
    page: Page,
    request: APIRequestContext,
    heroAlt?: Record<string, string>
  ) => {
    const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
      type: 'article',
      slug: 'quality-article-v3',
    });
    const { revision: source } = await callApi<{
      revision: { document: { blocks: { type: string; props: { mediaId?: string } }[] } };
    }>(request, 'content.item.get', { itemId: items[0]!.id });
    const mediaId = source.document.blocks.find((b) => b.type === 'image')?.props.mediaId;
    expect(mediaId).toBeTruthy();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `hero-alt-${test.info().project.name}-${randomBytes(4).toString('hex')}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Een beeld', en: 'An image' },
        heroImageId: mediaId,
        ...(heroAlt && { heroAlt }),
        blocks: [],
      },
    });
    const edit = `/admin/probe/content/${item.id}`;
    const line = page.locator('[data-hero-alt]:not([data-block-alt])');
    const summary = line.locator('summary');
    const field = page.locator('#heroAlt');
    const stored = async () =>
      (
        await callApi<{ revision: { document: { heroAlt?: Record<string, string> } } }>(
          request,
          'content.item.get',
          { itemId: item.id }
        )
      ).revision.document.heroAlt;
    // The line's live state and the focus on opening come from the screen's script; a step before
    // it has run gets the native behaviour, which is fine for a person but not what is tested (#178).
    const ready = () => editorReady(page);
    const visit = async (url: string) => {
      await page.goto(url);
      await ready();
    };
    const save = async () => {
      await page.getByRole('button', { name: 'Opslaan' }).first().click();
      await expect(page.getByRole('status').first()).toContainText('Opgeslagen');
      await ready();
    };
    return { mediaId, edit, line, summary, field, stored, ready, visit, save };
  };

  test('the hero description says its state without a click, and leaving it empty is decorative (#158)', async ({
    page,
    request,
  }) => {
    const { edit, line, summary, field, stored, ready, visit, save } = await heroAltArticle(
      page,
      request,
      { nl: 'Een straat.' }
    );

    // Filled here, missing in the other language: all of it visible while the line is closed.
    await login(page, `${edit}?locale=nl`);
    await ready();
    await expect(line).not.toHaveAttribute('open');
    await expect(field).toBeHidden();
    for (const words of ['Beschrijving', '· Nederlands', 'Een straat.', 'Bewerken'])
      await expect(summary).toContainText(words, { useInnerText: true });
    await expect(summary).toContainText('Ontbreekt nog in het Engels', { useInnerText: true });
    await expect(line).toHaveAttribute('data-tone', 'ok');
    // The layout belongs to the whole opening, not to the image.
    await expect(page.locator('.ui-edit-side #headerLayout')).toHaveCount(1);
    await expect(page.locator('.item-header #headerLayout')).toHaveCount(0);

    // The error tone on text carries no green check. Set by hand: no screen reaches it yet, because
    // publishing saves first and the panel offers only the language on screen.
    if (isA11y()) {
      await line.evaluate((el: HTMLElement) => (el.dataset.tone = 'err'));
      const described = line.locator('[data-hero-alt-state="described"]');
      await expect(described.locator('.icon.err')).toBeVisible();
      await expect(described.locator('.icon.ok')).toBeHidden();
    }

    // Missing on screen, with another language as reference: the refusal becomes an error.
    await visit(`${edit}?locale=en`);
    await expect(summary).toContainText('Beschrijving ontbreekt in het Engels', {
      useInnerText: true,
    });
    await expect(summary).toContainText('Beschrijven', { useInnerText: true });
    await expect(line).toHaveAttribute('data-tone', 'warn');
    await openPublication(page);
    const en = page.locator('#publication-en');
    await en.getByRole('link', { name: /hoofdbeeld/ }).click();
    await expect(line).toHaveAttribute('open');
    await expect(page.locator('[data-hero-alt-others]')).toContainText('Een straat.');
    await visit(`${edit}?locale=en`);
    await openPublication(page);
    await page
      .locator('#publication-en')
      .getByRole('button', { name: 'Publiceren', exact: true })
      .click();
    await expect(line).toHaveAttribute('data-tone', 'err');
    await expect(line).toHaveAttribute('open');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(line).toContainText('Vul de beschrijving in het Engels in.');
    if (isA11y()) await expectNoAxeViolations(page);
    await ready();

    // Typed: the status follows with a script (it also ends the refusal), and after the save.
    await closePublication(page);
    await field.fill('A street.');
    if (isA11y()) {
      await expect(summary).toContainText('A street.', { useInnerText: true });
      await expect(line).toHaveAttribute('data-tone', 'ok');
      await expect(field).not.toHaveAttribute('aria-invalid');
    }
    await save();
    await expect(summary).toContainText('A street.', { useInnerText: true });
    await expect(summary).not.toContainText('Ontbreekt', { useInnerText: true });
    expect(await stored()).toEqual({ nl: 'Een straat.', en: 'A street.' });

    // Emptied in one of two languages: this one stays open, the other keeps its text.
    await visit(`${edit}?locale=nl`);
    await summary.click();
    await field.fill('');
    await save();
    await expect(summary).toContainText('Beschrijving ontbreekt in het Nederlands', {
      useInnerText: true,
    });
    expect(await stored()).toEqual({ en: 'A street.' });

    // The box removes every language, and says so before the save.
    await summary.click();
    await page.locator('#heroDecorative').check();
    if (isA11y())
      await expect(summary).toContainText('de beschrijving in alle talen vervalt', {
        useInnerText: true,
      });
    await save();
    await expect(summary).toContainText('Decoratief', { useInnerText: true });
    await expect(line).toHaveAttribute('data-tone', 'neutral');
    expect(await stored()).toBeUndefined();

    // Empty in the only language with text is decorative, without a box or a refusal.
    await summary.click();
    await expect(page.locator('#heroDecorative')).toHaveCount(0);
    await field.fill('Alleen hier.');
    await save();
    expect(await stored()).toEqual({ nl: 'Alleen hier.' });
    await summary.click();
    await field.fill('');
    await save();
    await expect(summary).toContainText('Decoratief', { useInnerText: true });
    expect(await stored()).toBeUndefined();
  });

  test('the hero description follows a replaced or first image, by keyboard and at 320 px (#158)', async ({
    page,
    request,
    browser,
  }) => {
    onlyA11y();
    const { mediaId, edit, line, summary, field, ready, visit, save } = await heroAltArticle(
      page,
      request
    );
    await login(page, `${edit}?locale=nl`);
    await ready();
    // A described image, replaced: what described the old picture goes, and comes back with it.
    await summary.click();
    await field.fill('Terug.');
    await save();
    const picker = page.locator('#heroImageId');
    const choose = async (radio: string) => {
      await picker.getByRole('button', { name: /Vervangen|Beeld kiezen/ }).click();
      await picker.locator(radio).first().click();
      await picker.getByRole('button', { name: 'Klaar' }).click();
    };
    await choose(`input[type="radio"]:not([value=""]):not([value="${mediaId}"])`);
    await expect(summary).toContainText('Nieuw beeld, nog geen beschrijving', {
      useInnerText: true,
    });
    await expect(line).toHaveAttribute('data-tone', 'info');
    await expect(field).toHaveValue('');
    await choose(`input[type="radio"][value="${mediaId}"]`);
    await expect(summary).toContainText('Terug.', { useInnerText: true });
    await expect(field).toHaveValue('Terug.');
    await choose('input[type="radio"][value=""]');
    await expect(line).toBeHidden();
    await choose(`input[type="radio"][value="${mediaId}"]`);
    await save();
    // The keyboard: Enter opens into the field, Escape closes back onto the line.
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(field).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(line).not.toHaveAttribute('open');
    await expect(summary).toBeFocused();

    // No image yet: no line, until the first one is chosen.
    const { item: bare } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `hero-alt-bare-${test.info().project.name}-${randomBytes(4).toString('hex')}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Nog geen beeld' },
        blocks: [],
      },
    });
    await visit(`/admin/probe/content/${bare.id}`);
    await expect(line).toBeHidden();
    await picker.getByRole('button', { name: 'Beeld kiezen' }).click();
    await picker.locator('input[type="radio"]:not([value=""])').first().click();
    await picker.getByRole('button', { name: 'Klaar' }).click();
    await expect(summary).toContainText('Zonder beschrijving wordt dit beeld decoratief.', {
      useInnerText: true,
    });
    await expect(page.locator('#headerLayout')).toHaveCount(0);

    // The UI gate: status and action, image and Replace, the side column, at the longest language.
    for (const locale of ['nl-NL', 'en-GB']) {
      const context = await browser.newContext({
        locale,
        viewport: NARROW,
        baseURL: 'http://127.0.0.1:4173',
        extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
      });
      const narrow = await context.newPage();
      await login(narrow, `${edit}?locale=en`);
      await narrow.locator('[data-hero-alt]:not([data-block-alt]) summary').click();
      for (const size of TEXT_SIZES) {
        await setTextSize(narrow, size);
        await layoutGate(narrow, `hero description, ${locale}, ${size}`, '#heroImageId');
        await layoutGate(narrow, `side column, ${locale}, ${size}`, '.ui-edit-side');
        await narrow.locator('#heroImageId').screenshot({
          path: test.info().outputPath(`hero-alt-${locale}-${size.replace('%', '')}.png`),
        });
      }
      await context.close();
    }
  });

  /** The article with a cover header, published in nl. */
  const coverArticle = async (request: APIRequestContext) => {
    const slug = `e2e-cover-105-${isA11y() ? 'a11y' : 'no-js'}`;
    const { items } = await callApi(request, 'content.item.list', { type: 'article', slug });
    let target = items[0]
      ? await callApi(request, 'content.item.get', { itemId: items[0].id })
      : null;
    if (!target) {
      const [source] = (
        await callApi(request, 'content.item.list', { type: 'article', slug: 'quality-article-v3' })
      ).items;
      const { revision } = await callApi(request, 'content.item.get', { itemId: source.id });
      const doc: ContentDocument = structuredClone(revision.document);
      const image = doc.blocks.find((b) => b.type === 'image');
      doc.lead = { nl: 'Een straat die ruimte maakt.', en: 'A street that makes room.' };
      doc.heroImageId = (image!.props as { mediaId: string }).mediaId;
      doc.heroAlt = { nl: 'Een straat met bomen.', en: 'A street with trees.' };
      doc.locales = doc.locales.filter((l) => l === 'nl' || l === 'en');
      (doc as { presentation?: { header: string } }).presentation = { header: 'cover' };
      target = await callApi(request, 'content.item.create', { slug, document: doc });
    }
    const probe = await tenantId();
    await withInvoker((invoker) =>
      invoker.run(useCases.publishItem, systemPrincipal(probe, 'e2e'), {
        itemId: target.item.id,
        revisionId: target.revision.id,
        locale: 'nl',
      })
    );
    const path = `/probe/articles/${slug}`;
    return { target, path };
  };

  test('an article with a cover header fills the screen under the site header (#105)', async ({
    page,
    request,
  }) => {
    const { path } = await coverArticle(request);

    for (const size of [
      { width: 1440, height: 900 },
      { width: 375, height: 700 },
    ]) {
      await page.setViewportSize(size);
      await page.goto(path);
      await page.waitForLoadState('load');
      const cover = page.locator('main > header.page-cover');
      await expect(cover.locator('h1 span')).toBeVisible();
      await expect(page.locator('h1')).toHaveCount(1);
      await expect(cover.locator('img')).toHaveAttribute('fetchpriority', 'high');
      if (isA11y())
        expect(
          await page
            .locator('.page-cover-caption')
            .evaluate(
              (caption) =>
                caption.getBoundingClientRect().top -
                document.querySelector('.page-cover')!.getBoundingClientRect().bottom
            )
        ).toBeCloseTo(4, 1);
      await expect(cover.locator('img')).toHaveAttribute('alt', 'Een straat met bomen.');
      // The screen under the site's header, whatever the viewport; the page keeps its width.
      const boxes = await page.evaluate(() => ({
        cover: document.querySelector('.page-cover')!.getBoundingClientRect().height,
        header: document.querySelector('.site-header')!.getBoundingClientRect().height,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(boxes.overflow).toBeLessThanOrEqual(0);
      expect(Math.abs(boxes.cover + boxes.header - size.height)).toBeLessThanOrEqual(24);
      await expect(cover.getByRole('link', { name: 'Naar de inhoud' })).toHaveAttribute(
        'href',
        '#page-content'
      );
    }
  });

  test('a cover header is whole and reachable, and the editor chooses it (#105)', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const { target, path } = await coverArticle(request);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(path);
    await page.waitForLoadState('load');
    await expectNoAxeViolations(page);
    // The zoom runs, and reduced motion switches it off.
    const zoom = () =>
      page.locator('.page-cover img').evaluate((img) => getComputedStyle(img).animationName);
    expect(await zoom()).toBe('page-cover-zoom');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await zoom()).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // Whole at 320 px and 200 % text, and the arrow is keyboard reachable.
    await page.setViewportSize(NARROW);
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size);
      await layoutGate(page, `cover header at ${size}`, 'main');
    }
    // A word wider than the screen, in a browser or language without a hyphenation dictionary,
    // wraps inside the cover. The cover clips, so the document does not overflow and the gate
    // above cannot see it: compare every line of the title with the cover itself.
    await page.reload();
    await page.waitForLoadState('load');
    await page.locator('.page-cover h1').evaluate((h1) => {
      h1.style.hyphens = 'manual';
      h1.querySelector('span')!.textContent = 'Woningbouwontwikkelingsplannen'.repeat(3);
    });
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size);
      const fit = await page.locator('.page-cover').evaluate((cover) => {
        const box = cover.getBoundingClientRect();
        const lines = [...cover.querySelector('h1 span')!.getClientRects()];
        return {
          lines: lines.length,
          past: lines.filter((l) => l.left < box.left - 1 || l.right > box.right + 1).length,
        };
      });
      expect(fit.lines, `unbroken title wraps at ${size}`).toBeGreaterThan(1);
      expect(fit.past, `unbroken title stays inside the cover at ${size}`).toBe(0);
    }
    await page.reload();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('.page-cover-arrow').focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/#page-content$/);

    // The choice sits in the editor of an article, and the preview of the unsaved form shows the
    // same header, whole in a narrow frame; an article has no live-preview panel yet (#11), so
    // this posts to the route that panel uses.
    await login(page, `/admin/probe/content/${target.item.id}`);
    await expect(page.locator('#headerLayout')).toHaveValue('cover');
    await page.setViewportSize(NARROW);
    await postDraftPreview(page, target.item.id);
    await expect(page.locator('main > header.page-cover h1 span')).toBeVisible();
    await page.waitForLoadState('load');
    await layoutGate(page, 'cover header in the draft preview', 'main');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/admin/probe/content/${target.item.id}`);
    await page.locator('#headerLayout').selectOption('standard');
    await postDraftPreview(page, target.item.id);
    await expect(page.locator('main > figure.page-hero img')).toBeVisible();
    await expect(page.locator('main > header.page-cover')).toHaveCount(0);
    await page.goto(`/admin/probe/content/${target.item.id}`);
    await expect(page.locator('#headerLayout')).toHaveValue('cover');
    await page.locator('#headerLayout').selectOption('standard');
    await page.getByRole('button', { name: 'Opslaan' }).first().click();
    await expect(page.getByRole('status').first()).toContainText('Opgeslagen');
    await expect(page.locator('#headerLayout')).toHaveValue('standard');
    const saved = await callApi(request, 'content.item.get', { itemId: target.item.id });
    expect(saved.revision.document).not.toHaveProperty('presentation');
    await callApi(request, 'content.item.update', {
      itemId: target.item.id,
      baseRevisionId: saved.revision.id,
      document: { ...saved.revision.document, presentation: { header: 'cover' } },
    });
    // A page has no such choice.
    const [ordinary] = (await callApi(request, 'content.item.list', { type: 'page' })).items;
    await page.goto(`/admin/probe/content/${ordinary.id}`);
    await expect(page.locator('#headerLayout')).toHaveCount(0);
  });

  test('the JSON read route serves the same article without a key', async ({ request }) => {
    const api = requireApi();
    const url = `${api}/v1/sites/probe/content/article/${ARTICLE}`;
    const res = await request.get(`${url}?locale=en`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('public, max-age=60, stale-while-revalidate=600');
    const body = await res.json();
    expect(body).toMatchObject({
      type: 'article',
      locale: 'en',
      title: 'Trees in the street',
      lead: 'Why the neighbourhood wants more green.',
      authors: [{ slug: 'e2e-auteur', name: 'Sam de Vries' }],
      section: { slug: 'e2e-stad', name: 'City' },
    });
    expect(JSON.stringify(body)).not.toContain('sam@probe.test');
    const again = await request.get(`${url}?locale=en`, {
      headers: { 'if-none-match': res.headers()['etag']! },
    });
    expect(again.status()).toBe(304);
    expect((await request.get(`${api}/v1/sites/probe/content/page/${ARTICLE}`)).status()).toBe(404);
  });
});

// Composition coverage uses real published documents and the existing preview renderer.
// Rejected: standalone HTML fixtures that drift from production blocks.
test.describe('grid-compositions', () => {
  const compositions = [
    { slug: 'grid-information-v1', type: 'page', title: 'Samen zorgen voor de buurt' },
    { slug: 'campagne', type: 'page', title: 'Schone lucht, nu' },
    { slug: 'quality-article-v3', type: 'article', title: 'De straat die ruimte maakt' },
  ];

  async function item(request: APIRequestContext, entry: (typeof compositions)[number]) {
    const { items } = await callApi(request, 'content.item.list', {
      type: entry.type,
      slug: entry.slug,
    });
    expect(items).toHaveLength(1);
    return callApi(request, 'content.item.get', { itemId: items[0].id });
  }

  test.use({ locale: 'nl-NL', extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

  test.beforeAll(async ({ request }) => {
    onlyA11y('composition measurements run in a11y');
    // The third composition adds ordinary information prose around existing, resolved media.
    // Reuse synthetic assets and references, never upload or contact an external provider.
    const { items } = await callApi(request, 'content.item.list', {
      type: 'page',
      slug: compositions[0]!.slug,
    });

    const source = await item(request, compositions[1]!);
    const doc: ContentDocument = structuredClone(source.revision.document);
    doc.title = { nl: compositions[0]!.title, en: 'Caring for the neighbourhood together' };
    doc.blocks = doc.blocks.filter((block) => !['hero', 'form'].includes(block.type));
    const prose = doc.blocks.find((block) => block.type === 'rich-text')!;
    doc.blocks.push({ ...structuredClone(prose), id: 'information-closing' });
    const created = items.length
      ? await item(request, compositions[0]!)
      : await callApi(request, 'content.item.create', {
          slug: compositions[0]!.slug,
          document: doc,
        });
    const probe = await tenantId();
    await withInvoker(async (invoker) => {
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, systemPrincipal(probe, 'e2e'), {
          itemId: created.item.id,
          revisionId: created.revision.id,
          locale,
        });
    });
  });

  async function metrics(page: Page) {
    await page.evaluate(() => document.fonts.ready);
    return page.evaluate(() => {
      const box = (selector: string) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, width: r.width, bottom: r.bottom, top: r.top };
      };
      return {
        viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        font: getComputedStyle(document.body).fontFamily,
        fontSize: getComputedStyle(document.body).fontSize,
        measure: getComputedStyle(document.querySelector('.page')!).getPropertyValue(
          '--content-width'
        ),
        prose: box('.page .rich-text'),
        wide: box('.page .layout-wide'),
        full: box('.page .layout-full'),
        title: box('.page h1'),
        floats: [...document.querySelectorAll('.page [class*="layout-float-"]')].map(
          (el) => getComputedStyle(el).float
        ),
      };
    });
  }

  /** The item title sits centred in its own 52rem rail (brief 46C-1 rule 8): never narrower
   *  than the reading column, never wider than the rail, its centre on the viewport's. */
  function expectTitleRail(
    title: { x: number; width: number },
    prose: { width: number },
    viewport: number
  ) {
    expect(title.width).toBeGreaterThanOrEqual(prose.width - 1);
    expect(title.width).toBeLessThanOrEqual(52 * 16 + 1);
    expect(Math.abs(title.x + title.width / 2 - viewport / 2)).toBeLessThanOrEqual(1);
  }

  for (const entry of compositions)
    for (const width of [320, 768, 1440])
      test(`${entry.slug}: composition at ${width}px`, async ({ page }) => {
        onlyA11y('DOM measurements');
        await page.setViewportSize({ width, height: 900 });
        const path = `/probe/${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`;
        expect((await page.goto(path))?.status()).toBe(200);
        await expect(page.locator('main h1')).toHaveText(entry.title);
        const measured = await metrics(page);
        await test.info().attach('rails.json', {
          body: JSON.stringify(measured),
          contentType: 'application/json',
        });
        expect(measured.overflow).toBe(false);
        if (measured.full) expect(measured.full.width).toBe(width);
        if (width === 1440 && measured.wide) expect(measured.wide.width).toBe(1088);
        expectTitleRail(measured.title!, measured.prose!, measured.viewport);
        if (width === 1440) {
          expect(measured.prose!.width).toBeGreaterThanOrEqual(680);
          expect(measured.prose!.width).toBeLessThanOrEqual(740);
        }
      });

  for (const entry of compositions)
    test(`${entry.slug}: saved and live preview share the public rails`, async ({
      page,
      request,
    }) => {
      onlyA11y('live preview is an enhancement');
      await page.setViewportSize({ width: 1440, height: 1000 });
      const saved = await item(request, entry);
      await page.context().setExtraHTTPHeaders({
        'x-forwarded-proto': 'http',
        'x-forwarded-for': `2001:db8:46::${Math.floor(Math.random() * 0xffff).toString(16)}`,
      });
      await page.goto(`/admin/probe/content/${saved.item.id}`);
      await page.locator('main a[href*="start=1"]').click();
      await page.getByLabel('E-mail').fill('e2e-admin@probe.test');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(new RegExp(`/content/${saved.item.id}$`));
      const edit = page.url();
      const href = await page.locator('a[data-preview-link="nl"]').getAttribute('href');
      await page.goto(href!);
      const savedMetrics = await metrics(page);
      expect(savedMetrics.overflow).toBe(false);
      expect(savedMetrics.prose!.width).toBeGreaterThanOrEqual(680);
      expectTitleRail(savedMetrics.title!, savedMetrics.prose!, savedMetrics.viewport);
      await page.goto(edit);
      if (entry.type === 'article') {
        // The article writer has no automatic live-preview panel yet. Exercise the real
        // unsaved-document route with the unchanged native metadata form; this proves the
        // renderer, not a missing writer interaction (which remains owned by #11).
        await postDraftPreview(page, saved.item.id);
        await expect(page.locator('main h1')).toHaveText(entry.title);
        // Measured once the site's stylesheet applies: before \`load\` the prose has the 40rem of
        // the unstyled fallback (640px), which made this a load-timing flake (#66 PR 3).
        await page.waitForLoadState('load');
        const draft = await metrics(page);
        expect(draft.overflow).toBe(false);
        expect(draft.prose!.width).toBeCloseTo(savedMetrics.prose!.width, 0);
        await test.info().attach('article-draft-rails.json', {
          body: JSON.stringify({ saved: savedMetrics, draft, writerLivePanel: 'not-implemented' }),
          contentType: 'application/json',
        });
        return;
      }
      // The preview opens on its toggle (#66 PR 3).
      await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
      const frame = page.frameLocator('[data-live-preview-frame]');
      await expect(frame.locator('main h1')).toHaveText(entry.title);
      // The real editor gives the iframe a narrower container than the monitor. Its own
      // viewport, rather than the parent admin viewport, determines the public rails.
      const live = await frame.locator('main').evaluate((main) => {
        const width = main.ownerDocument.documentElement.clientWidth;
        const prose = main.querySelector('.rich-text')!.getBoundingClientRect();
        const title = main.querySelector('h1')!.getBoundingClientRect();
        return {
          width,
          prose: prose.width,
          title: { x: title.x, width: title.width },
          overflow: main.ownerDocument.documentElement.scrollWidth > width + 1,
        };
      });
      expect(live.overflow).toBe(false);
      expectTitleRail(live.title, { width: live.prose }, live.width);
      await test.info().attach('preview-rails.json', {
        body: JSON.stringify({ saved: savedMetrics, live }),
        contentType: 'application/json',
      });
      await page.setViewportSize({ width: live.width, height: 900 });
      await page.goto(`/probe/${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`);
      expect((await metrics(page)).prose!.width).toBeCloseTo(live.prose, 0);
    });

  // Brief 46C-1 rules 1 to 4: a caption starts at its image's left edge, whatever the layout;
  // only an edgeless (full) image insets its caption by the gutter; a float beside the text
  // stands out of the reading column on a wide screen. At 375 px nothing scrolls sideways.
  test('captions share the left edge of their image and a float stands out of the column', async ({
    page,
  }) => {
    onlyA11y('DOM measurements');
    const figures = () =>
      page.evaluate(() => {
        const prose = document.querySelector('.page .rich-text')!.getBoundingClientRect();
        const figure = (selector: string) => {
          const el = document.querySelector(`.page > figure.image.${selector}`)!;
          const img = el.querySelector('img')!.getBoundingClientRect();
          const caption = el.querySelector('figcaption')!;
          const box = caption.getBoundingClientRect();
          return {
            img: { left: img.left, right: img.right, width: img.width },
            caption: { left: box.left, width: box.width, gap: box.top - img.bottom },
            inset: parseFloat(getComputedStyle(caption).paddingInlineStart),
            figure: el.getBoundingClientRect().right,
          };
        };
        return {
          prose: { left: prose.left, right: prose.right },
          wide: figure('layout-wide'),
          full: figure('layout-full'),
          float: figure('layout-float-right'),
          overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        };
      });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/probe/articles/quality-article-v3');
    await page.evaluate(() => document.fonts.ready);
    const wide = await figures();
    await test.info().attach('captions-1440.json', {
      body: JSON.stringify(wide),
      contentType: 'application/json',
    });
    for (const key of ['wide', 'full', 'float'] as const) {
      const f = wide[key];
      expect(f.caption.left).toBeCloseTo(f.img.left, 0);
      expect(f.caption.width).toBeCloseTo(f.img.width, 0);
      expect(f.caption.gap).toBeCloseTo(4, 1);
    }
    expect(wide.wide.inset).toBe(0);
    expect(wide.float.inset).toBe(0);
    // The full image touches the screen edge: its caption text starts one gutter (1rem) in.
    expect(wide.full.img.left).toBe(0);
    expect(wide.full.inset).toBe(16);
    // The lead sits centred under the title in its own 44rem rail (brief 46C-1 rule 8).
    const lead = await page.locator('main > .lead').evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, width: r.width, align: getComputedStyle(el).textAlign };
    });
    expect(lead.align).toBe('center');
    expect(lead.width).toBeLessThanOrEqual(44 * 16 + 1);
    expect(Math.abs(lead.x + lead.width / 2 - 720)).toBeLessThanOrEqual(1);
    // Half the reading column, standing 8rem out of it.
    expect(wide.float.figure).toBeGreaterThan(wide.prose.right + 100);
    expect(wide.float.img.width).toBeCloseTo((wide.prose.right - wide.prose.left) / 2, 0);

    await page.setViewportSize({ width: 375, height: 800 });
    await page.reload();
    const narrow = await figures();
    expect(narrow.overflow).toBe(false);
    expect(narrow.float.caption.left).toBeCloseTo(narrow.float.img.left, 0);
    expect(narrow.full.inset).toBeGreaterThan(0);
    await page.goto('/probe/blok-image-content');
    expect(
      await page
        .locator('figure.image figcaption')
        .evaluate(
          (caption) =>
            caption.getBoundingClientRect().top -
            document.querySelector('figure.image img')!.getBoundingClientRect().bottom
        )
    ).toBeCloseTo(4, 1);
  });

  test('a narrow composition on a wide monitor contains floats and full media', async ({
    page,
  }) => {
    onlyA11y('DOM measurements');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/probe/articles/quality-article-v3');
    await page.evaluate(() => {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('.page { max-width: 400px; margin-inline: auto; }');
      document.adoptedStyleSheets.push(sheet);
    });
    const measured = await metrics(page);
    expect(measured.floats).toEqual(['none', 'none']);
    expect(measured.full!.width).toBe(400);
    expect(measured.prose!.width).toBeGreaterThan(360);
    expect(measured.prose!.width).toBeLessThanOrEqual(368);
    expect(measured.overflow).toBe(false);
  });

  // Chrome's tabs API changes actual desktop browser zoom. Pinch/pageScaleFactor and a larger
  // root font cannot prove this: assert the halved CSS viewport and doubled pixel ratio too.
  test('real Chromium 200% browser zoom reflows the composition', async ({ request }) => {
    onlyA11y('browser zoom measurement');
    const directory = await mkdtemp(join(tmpdir(), 'mycel-zoom-'));
    let context;
    try {
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify({
          manifest_version: 3,
          name: 'Mycel layout measurement',
          version: '1.0',
          permissions: ['tabs'],
          background: { service_worker: 'worker.js' },
        })
      );
      await writeFile(
        join(directory, 'worker.js'),
        'chrome.runtime.onInstalled.addListener(() => {});'
      );
      context = await chromium.launchPersistentContext('', {
        channel: 'chromium',
        headless: true,
        viewport: null,
        args: [
          `--disable-extensions-except=${directory}`,
          `--load-extension=${directory}`,
          '--window-size=1440,1000',
        ],
      });
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const page = await context.newPage();
      await page.goto('http://127.0.0.1:4173/probe/articles/quality-article-v3');
      const before = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }));
      await worker.evaluate(async () => {
        // chrome is provided by this measurement extension, not by application code.
        const api = (
          globalThis as unknown as {
            chrome: {
              tabs: {
                query: (q: object) => Promise<{ id: number; url: string }[]>;
                setZoom: (id: number, factor: number) => Promise<void>;
              };
            };
          }
        ).chrome;
        const tab = (await api.tabs.query({})).find((tab) => tab.url.includes('/probe/articles/'))!;
        await api.tabs.setZoom(tab.id, 2);
      });
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(before.ratio * 2);
      const after = await metrics(page);
      expect(after.viewport).toBeCloseTo(before.width / 2, 0);
      expect(after.overflow).toBe(false);
      expectTitleRail(after.title!, after.prose!, after.viewport);
      await writeFile(
        test.info().outputPath('browser-zoom.json'),
        JSON.stringify({ before, after, version: context.browser()?.version() })
      );
      await test.info().attach('browser-zoom.json', {
        body: JSON.stringify({ before, after, version: context.browser()?.version() }),
        contentType: 'application/json',
      });
      await page.screenshot({
        path: test.info().outputPath('browser-zoom-200.png'),
        fullPage: true,
      });
      await page.goto('http://127.0.0.1:4173/probe/blok-faq-accordion-full');
      const faq = await page.evaluate(() => {
        const section = document.querySelector('main > .faq')!.getBoundingClientRect();
        const answer = document.querySelector('.faq .answer')!.getBoundingClientRect();
        return {
          viewport: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          section: section.width,
          answer: answer.width,
          ratio: devicePixelRatio,
        };
      });
      expect(faq.viewport).toBeCloseTo(before.width / 2, 0);
      expect(faq.ratio).toBe(before.ratio * 2);
      expect(faq.scroll).toBeLessThanOrEqual(faq.viewport + 1);
      expect(faq.section).toBe(faq.viewport);
      expect(faq.answer).toBeLessThanOrEqual(faq.section);
      await page.locator('summary').focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('.faq details')).toHaveAttribute('open', '');
      await page.screenshot({
        path: test.info().outputPath('faq-browser-zoom-200.png'),
        fullPage: true,
      });
      await test.info().attach('faq-browser-zoom.json', {
        body: JSON.stringify({ faq, version: context.browser()?.version() }),
        contentType: 'application/json',
      });
      // The same origin retains real browser zoom across the admin navigation.
      await login(page, '/admin/probe/content?type=page');
      await expect(page.locator('.admin-sidebar')).toBeVisible();
      expect(await page.evaluate(() => devicePixelRatio)).toBe(before.ratio * 2);
      await page.locator('.admin-menu > summary').click();
      await layoutGate(page, 'admin at real 200% browser zoom', '.admin-sidebar');
      await page.screenshot({
        path: test.info().outputPath('admin-browser-zoom-200.png'),
        fullPage: true,
      });
      const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
        slug: `zoom-editor-${Date.now()}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: 'Een schrijfvlak bij echte browserzoom' },
          blocks: [],
        },
      });
      await page.goto(`http://127.0.0.1:4173/admin/probe/content/${item.id}`);
      await expect(page.locator('.ui-writing-sheet')).toBeVisible();
      expect(await page.evaluate(() => innerWidth)).toBeCloseTo(before.width / 2, 0);
      expect(await page.evaluate(() => devicePixelRatio)).toBe(before.ratio * 2);
      await layoutGate(page, 'editor at real 200% browser zoom');
      await expectNoAxeViolations(page);
      await page.screenshot({
        path: test.info().outputPath('editor-browser-zoom-200.png'),
        fullPage: true,
      });
      await openPublication(page);
      await layoutGate(page, 'publication at real 200% browser zoom', '#publication-panel');
      await expectNoAxeViolations(page);
      await page.screenshot({ path: test.info().outputPath('publication-browser-zoom-200.png') });
      await closePublication(page);
      await expect(page.locator('a[href="#publication-panel"]')).toBeFocused();
    } finally {
      await context?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const entry of compositions)
    for (const locale of ['nl', 'en'])
      test(`${entry.slug} ${locale}: separate text enlargement and spacing stress`, async ({
        page,
      }) => {
        onlyA11y('DOM measurements');
        await page.setViewportSize(NARROW);
        await page.goto(
          `/probe/${locale === 'en' ? 'en/' : ''}${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`
        );
        for (const spacing of [false, true]) {
          await setTextSize(page, '200%');
          if (spacing) await setTextSpacing(page);
          await layoutGate(page, spacing ? 'with WCAG text spacing' : '200% text');
        }
      });
});

// A complete bilingual site: tenant chrome and theme through real use cases and the public
// renderer, including the no-JavaScript/320 px/200% task gate (#11 E, ADR 009/013).
test.describe('site-settings', () => {
  const slug = `chrome-${Math.random().toString(36).slice(2, 8)}`;
  const singleSlug = `chrome-single-${Math.random().toString(36).slice(2, 8)}`;
  let tenantId = '';
  let singleTenantId = '';
  let homeItemId = '';
  const WALK = {
    light: [
      { foreground: '#ffffff', background: '#d32f2f' },
      { foreground: '#ffffff', background: '#2e7d32' },
    ],
    dark: [
      { foreground: '#ffffff', background: '#2e7d32' },
      { foreground: '#ffffff', background: '#c62828' },
    ],
  };
  const { light, dark } = THEME_PRESETS.editorial.palettes;
  const ACCENTED = {
    ...THEME_PRESETS.editorial,
    palettes: {
      light: { ...light, cardAccents: WALK.light },
      dark: { ...dark, cardAccents: WALK.dark },
    },
  };
  const rgb = (hex: string) =>
    `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  // A button's colour goes through `color-mix`, which Chromium reports as `color(srgb r g b)`.
  const asRgb = (css: string) => {
    const srgb = /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(css);
    return srgb
      ? `rgb(${srgb
          .slice(1)
          .map((c) => Math.round(Number(c) * 255))
          .join(', ')})`
      : css;
  };
  const themeState = (id: string) =>
    withInvoker((invoker) => invoker.run(useCases.getSiteTheme, systemPrincipal(id, 'e2e'), {}));
  const chromeState = (id: string) =>
    withInvoker((invoker) => invoker.run(useCases.getSiteChrome, systemPrincipal(id, 'e2e'), {}));

  test.use({
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
    viewport: { width: 320, height: 720 },
  });
  test.beforeAll(async () => {
    const [tenant, singleTenant] = await asOwner(async (owner) => [
      await testTenant(owner, slug, {
        name: 'Chrome fixture',
        locales: ['nl', 'en', 'de'],
        platformDomain: process.env['PLATFORM_DOMAIN']!,
      }),
      await testTenant(owner, singleSlug, {
        name: 'Single-locale fixture',
        platformDomain: process.env['PLATFORM_DOMAIN']!,
      }),
    ]);
    tenantId = tenant.id;
    singleTenantId = singleTenant.id;
    await withInvoker(async (invoker) => {
      const principal = systemPrincipal(tenant.id, 'e2e');
      await invoker.run(useCases.inviteMember, principal, {
        email: `site-editor-${slug}@probe.test`,
        capabilities: ['content:write', 'content:read', 'media:read', 'media:write'],
      });
      await invoker.run(useCases.inviteMember, systemPrincipal(singleTenant.id, 'e2e'), {
        email: `site-editor-${singleSlug}@probe.test`,
        capabilities: ['content:write', 'content:read'],
      });
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug: 'home',
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Welkom', en: 'Welcome' },
          blocks: [],
        },
      });
      homeItemId = item.id;
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, principal, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
      await invoker.run(useCases.updateSiteTheme, principal, {
        baseVersion: 0,
        theme: ACCENTED,
      });
      // An action row of four filled cards walks the theme's two accents per mode.
      const row = await invoker.run(useCases.createItem, principal, {
        slug: 'acties',
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: 'Acties' },
          blocks: [
            {
              id: 'row',
              type: 'cards',
              version: 1,
              props: {
                accent: 'filled',
                width: 'wide',
                cards: ['Een', 'Twee', 'Drie', 'Vier'].map((nl) => ({
                  title: { nl },
                  actions: [
                    {
                      label: { nl: `Naar ${nl}` },
                      target: { kind: 'url' as const, url: 'https://example.org/' },
                    },
                  ],
                })),
              },
            },
          ],
        },
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: row.item.id,
        revisionId: row.revision.id,
        locale: 'nl',
      });
      await invoker.run(useCases.updateSiteChrome, principal, {
        baseVersion: 0,
        chrome: {
          navigation: [
            { href: '/home', label: { nl: 'Welkom', en: 'Home', de: 'Startseite' } },
            { href: '/en/home', label: { nl: 'English', en: 'English', de: 'Englisch' } },
          ],
          footer: {
            nl: 'Een onafhankelijke site',
            en: 'An independent site',
            de: 'Eine unabhängige Website',
          },
          legal: [
            {
              href: 'https://example.org/privacy',
              label: { nl: 'Privacyverklaring', en: 'Privacy policy', de: 'Datenschutz' },
            },
          ],
          support: {
            href: 'https://example.org/support',
            label: { nl: 'Hulp', en: 'Support', de: 'Unterstützung' },
          },
          help: {
            href: 'https://example.org/help',
            label: { nl: 'Vraag', en: 'Help', de: 'Hilfe' },
          },
        },
      });
      await invoker.run(useCases.updateSiteChrome, systemPrincipal(singleTenant.id, 'e2e'), {
        baseVersion: 0,
        chrome: {
          navigation: [{ href: '/home', label: { nl: 'Welkom' } }],
          footer: { nl: 'Een taal' },
          legal: [],
          support: null,
          help: null,
        },
      });
    });
  });
  for (const locale of ['nl', 'en'])
    test(`${locale} navigation, footer and theme at narrow/large text`, async ({ page }) => {
      await page.goto(`/${slug}${locale === 'en' ? '/en' : ''}/home`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        locale === 'nl' ? 'Welkom' : 'Welcome'
      );
      await expect(
        page
          .getByRole('navigation', { name: locale === 'nl' ? 'Hoofdnavigatie' : 'Main navigation' })
          .getByRole('link')
          .first()
      ).toHaveText(locale === 'nl' ? 'Welkom' : 'Home');
      await expect(page.getByRole('contentinfo')).toContainText(
        locale === 'nl' ? 'Een onafhankelijke site' : 'An independent site'
      );
      await expect(page.locator('link[rel=stylesheet][href*="/_theme/"]')).toHaveCount(1);
      const fontSize = await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
        return parseFloat(getComputedStyle(document.documentElement).fontSize);
      });
      expect(fontSize).toBeGreaterThanOrEqual(32);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      // CSS zoom exercises Chromium's scaled layout separately from enlarged text. The two
      // checks together catch both narrow viewport reflow and whole navigation labels.
      const zoomed = await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
        document.documentElement.style.zoom = '2';
        return (
          [...document.querySelectorAll('.site-header a, .site-footer a')].every(
            (node) => node.getBoundingClientRect().right <= innerWidth
          ) && document.documentElement.scrollWidth <= innerWidth
        );
      });
      expect(zoomed).toBe(true);
      await expectNoAxeViolations(page);
    });

  // The action row's colours come from the theme, card by card and per mode, and the button on a
  // filled card is its pair inverted (theme.md § Contrast).
  test('an action row walks the theme accents, with the button inverted', async ({ page }) => {
    for (const mode of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.goto(`/${slug}/acties`);
      const cards = page.locator('.cards-item');
      await expect(cards).toHaveCount(4);
      const seen = await cards.evaluateAll((items) =>
        items.map((item) => {
          const button = getComputedStyle(item.querySelector('.button')!);
          return [getComputedStyle(item).backgroundColor, button.backgroundColor, button.color];
        })
      );
      expect(seen.map((colours) => colours.map(asRgb))).toEqual(
        [0, 1, 0, 1].map((i) => {
          const pair = WALK[mode][i]!;
          return [rgb(pair.background), rgb(pair.foreground), rgb(pair.background)];
        })
      );
      if (isA11y()) await expectNoAxeViolations(page, { label: `action row ${mode}` });
    }
  });

  test('native site forms preserve locales and reject stale changes', async ({
    page,
    request,
    context,
  }) => {
    await page.goto(`/${slug}/home`);
    const oldCss = await page
      .locator('link[rel=stylesheet][href*="/_theme/"]')
      .getAttribute('href');
    await login(page, `/admin/${slug}/site?section=theme`, `site-editor-${slug}@probe.test`);
    await page.locator('select[name="fontPair"]').selectOption('inter');
    // The action row's card colours are rows of the colour table: a third light card
    // is added and the second dark one emptied; untouched rows keep what was stored.
    const card = (mode: string, i: number, side: string) =>
      page.locator(`input[type="text"][name="${mode}.cardAccents.${i}.${side}"]`);
    await expect(card('light', 0, 'background')).toHaveValue(WALK.light[0]!.background);
    await card('light', 2, 'foreground').fill('#000000');
    await card('light', 2, 'background').fill('#ffd54f');
    await card('dark', 1, 'foreground').fill('');
    await card('dark', 1, 'background').fill('');
    await page.getByRole('button', { name: 'Save theme' }).click();
    await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
    const theme = (await themeState(tenantId)).value;
    expect(theme.fontPair).toBe('inter');
    expect(theme.palettes.light.cardAccents).toEqual([
      ...WALK.light,
      { foreground: '#000000', background: '#ffd54f' },
    ]);
    expect(theme.palettes.dark.cardAccents).toEqual([WALK.dark[0]]);
    // A half-filled card is refused by core, not completed by the form; the light walk stays.
    await card('light', 3, 'background').fill('#123456');
    await page.getByRole('button', { name: 'Save theme' }).click();
    await expect(page.getByRole('alert')).toContainText('Check the fields and colour contrast.');
    await expect(card('light', 3, 'background')).toHaveValue('#123456');
    expect((await themeState(tenantId)).value.palettes.light.cardAccents).toHaveLength(3);
    const stalePage = await context.newPage();
    await stalePage.goto(`/admin/${slug}/site?section=chrome`);
    await page.goto(`/admin/${slug}/site?section=chrome`);
    await page.locator('input[name="footer.en"]').fill('New footer');
    await page.locator('form[action$="&/chrome"]').getByRole('button').click();
    await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
    let saved = await chromeState(tenantId);
    expect(saved.value.footer).toEqual({
      nl: 'Een onafhankelijke site',
      en: 'New footer',
      de: 'Eine unabhängige Website',
    });
    expect(saved.value.navigation[0]?.label.de).toBe('Startseite');
    expect(saved.value.legal[0]?.label.de).toBe('Datenschutz');
    expect(saved.value.support?.label.de).toBe('Unterstützung');
    expect(saved.value.help?.label.de).toBe('Hilfe');
    await stalePage.locator('input[name="footer.en"]').fill('Stale footer');
    await stalePage.locator('form[action$="&/chrome"]').getByRole('button').click();
    await expect(stalePage.locator('[role="alert"]')).toBeVisible();
    expect((await chromeState(tenantId)).value.footer.en).toBe('New footer');
    await page.goto(`/admin/${slug}/site?section=chrome`);
    await expect(page.locator('input[name="footer.en"]')).toHaveValue('New footer');
    await expect(page.locator('input[name="footer.de"]')).toHaveValue('Eine unabhängige Website');
    await page.locator('input[name="footer.de"]').fill('');
    await page.locator('input[name="help.href"]').fill('');
    await page.locator('form[action$="&/chrome"]').getByRole('button').click();
    await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
    saved = await chromeState(tenantId);
    expect(saved.value.footer.de).toBeUndefined();
    expect(saved.value.help).toBeNull();
    expect(saved.value.legal[0]?.label.de).toBe('Datenschutz');
    await page.goto(`/${slug}/en/home`);
    await expect(page.getByRole('contentinfo')).toContainText('New footer');
    const newCss = await page
      .locator('link[rel=stylesheet][href*="/_theme/"]')
      .getAttribute('href');
    expect(newCss).not.toBe(oldCss);
    const stale = await request.get(oldCss!, { maxRedirects: 0 });
    expect(stale.status()).toBe(302);
    expect(stale.headers()['location']).toBe(newCss);
    expect(stale.headers()['cache-control']).toBe('no-store');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );
    await expectNoAxeViolations(page);
  });

  // #81-rest: the default image (`site.image.update`) has its own form and version beside the
  // logo, and the theme form carries the drop cap so a later theme save keeps a chosen `off`.
  test('the default image and the drop cap are chosen in the settings', async ({ page }) => {
    const principal = systemPrincipal(tenantId, 'e2e');
    const filename = `default-${Date.now()}.png`;
    await login(page, `/admin/${slug}/media`, `site-editor-${slug}@probe.test`);
    await page.getByRole('button', { name: 'Upload file', exact: true }).click();
    await page.getByLabel('Files (required)', { exact: true }).setInputFiles({
      name: filename,
      mimeType: 'image/png',
      buffer: Buffer.from(useCases.uploadMedia.examples[0]!.input.bytes, 'base64'),
    });
    await page.getByRole('button', { name: 'Upload', exact: true }).click();
    const src = await page.locator('article img').first().getAttribute('src');
    const mediaId = /media\/([0-9a-f-]{36})\/thumb/.exec(src ?? '')?.[1];
    expect(mediaId).toBeTruthy();
    const images = () =>
      withInvoker((invoker) => invoker.run(useCases.getSiteImages, principal, {}));
    const choose = async (name: string) => {
      const picker = page.getByRole('group', { name: 'Default image' });
      await picker.getByRole('button', { name: /^(Choose image|Replace)$/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Default image' });
      await dialog.getByRole('radio', { name }).check();
      await dialog.getByRole('button', { name: 'Done' }).click();
      await page.getByRole('button', { name: 'Save image' }).click();
      await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
    };
    await page.goto(`/admin/${slug}/site?section=brand`);
    await choose(filename);
    expect((await images()).value.defaultImageId).toBe(mediaId);
    await expect(page.locator('#site-defaultImageId [data-picker-name]')).toHaveText(filename);
    await expectNoAxeViolations(page);
    await page.goto(`/${slug}/home`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      'content',
      new RegExp(`/media/${mediaId}/`)
    );
    await page.goto(`/admin/${slug}/site?section=brand`);
    await choose('No image');
    expect((await images()).value.defaultImageId).toBeNull();

    const theme = () => withInvoker((invoker) => invoker.run(useCases.getSiteTheme, principal, {}));
    await page.goto(`/admin/${slug}/site?section=theme`);
    const dropCap = page.getByLabel('Drop cap on articles');
    await expect(dropCap).toHaveValue('articles');
    await dropCap.selectOption('off');
    await page.getByRole('button', { name: 'Save theme' }).click();
    await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
    expect((await theme()).value.dropCap).toBe('off');
    await page.goto(`/admin/${slug}/site?section=theme`);
    await expect(dropCap).toHaveValue('off');
    await page.getByRole('button', { name: 'Save theme' }).click();
    await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
    expect((await theme()).value.dropCap).toBe('off');
  });

  test('single-locale site saves without another translation', async ({ page }) => {
    await login(
      page,
      `/admin/${singleSlug}/site?section=chrome`,
      `site-editor-${singleSlug}@probe.test`
    );
    await expect(page.locator('input[name="footer.nl"]')).toHaveValue('Een taal');
    await expect(page.locator('input[name="footer.en"]')).toHaveCount(0);
    await page.locator('input[name="footer.nl"]').fill('Nieuwe tekst');
    await page.locator('form[action$="&/chrome"]').getByRole('button').click();
    await expect(page.locator('[role="status"]')).toBeVisible();
    expect((await chromeState(singleTenantId)).value.footer).toEqual({ nl: 'Nieuwe tekst' });
  });

  // Uploads the logo and wordmark font through the real brand forms. The site settings gate seeds
  // them itself so it measures the longest action labels ("Vervangen"/"Verwijderen") even when run
  // alone; rejected: relying on the upload test running first in the same worker.
  const uploadBrand = async (page: Page, largeLogo?: Buffer) => {
    await page.goto(`${new URL(page.url()).pathname}?section=brand`);
    const [logo, font] = [
      page.locator('form[action$="&/brand"]').first(),
      page.locator('form[action$="&/brand"]').last(),
    ];
    await logo.locator('input[type=file]').setInputFiles({
      name: largeLogo ? 'large.png' : 'mark.svg',
      mimeType: largeLogo ? 'image/png' : 'image/svg+xml',
      buffer:
        largeLogo ??
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#123456"/></svg>'
        ),
    });
    await logo.locator('button[value=upload]').click();
    await expect(page.locator('[role="status"]')).toBeVisible();
    await font.locator('input[type=file]').setInputFiles({
      name: 'inter.woff2',
      mimeType: 'font/woff2',
      buffer: await readFile(
        new URL('../static/fonts/inter/inter-latin-roman.woff2', import.meta.url)
      ),
    });
    await font.locator('input[name=licence]').fill('SIL Open Font License 1.1');
    await font.locator('button[value=upload]').click();
    await expect(page.locator('[role="status"]')).toBeVisible();
  };

  test('native brand upload, public derivative and removal stay tenant scoped', async ({
    page,
    request,
  }) => {
    await login(page, `/admin/${slug}/site`, `site-editor-${slug}@probe.test`);
    const largeLogo = await sharp(randomBytes(512 * 512 * 3), {
      raw: { width: 512, height: 512, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(largeLogo.length).toBeGreaterThan(512 * 1024);
    expect(largeLogo.length).toBeLessThan(2 * 1024 * 1024);
    await uploadBrand(page, largeLogo);

    // Over-limit files fit the multipart allowance but must still fail in the native action.
    for (const [index, size, mimeType] of [
      [0, 2 * 1024 * 1024 + 1, 'image/png'],
      [1, 1024 * 1024 + 1, 'font/woff2'],
    ] as const) {
      const form = page.locator('form[action$="&/brand"]').nth(index);
      await form.locator('input[type=file]').setInputFiles({
        name: 'oversized',
        mimeType,
        buffer: Buffer.alloc(size),
      });
      if (index === 1) await form.locator('input[name=licence]').fill('SIL Open Font License 1.1');
      const response = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).searchParams.has('/brand')
      );
      await form.locator('button[value=upload]').click();
      expect((await response).status()).toBe(400);
      await expect(page.locator('[role=alert]')).toBeVisible();
    }

    await page.goto(`/admin/${slug}/preview/item/${homeItemId}?locale=nl`);
    await expect(page.locator('.site-identity img')).toBeVisible();
    await expect(page.locator('.site-wordmark')).toContainText('Chrome fixture');

    await page.goto(`/${slug}/home`);
    const identity = page.locator('.site-identity');
    await expect(identity).toContainText('Chrome fixture');
    await expect(identity.locator('img')).toBeVisible();
    const logoUrl = await identity.locator('img').getAttribute('src');
    expect(logoUrl).toBeTruthy();
    const logoResponse = await request.get(logoUrl!);
    expect(logoResponse.status()).toBe(200);
    expect(logoResponse.headers()['content-type']).toBe('image/webp');
    expect(logoResponse.headers()['x-content-type-options']).toBe('nosniff');
    expect(logoResponse.headers()['cross-origin-resource-policy']).toBe('cross-origin');
    const previewLogo = await page.request.get(`/admin/${slug}/preview/_brand/logo/1.webp`);
    expect(previewLogo.status()).toBe(200);
    expect(previewLogo.headers()['cache-control']).toBe('no-store');
    expect((await request.get(`/${singleSlug}/_brand/logo/1.webp`)).status()).toBe(404);
    const stylesheet = await page
      .locator('link[rel=stylesheet][href*="/_theme/"]')
      .getAttribute('href');
    const css = await (await request.get(stylesheet!)).text();
    expect(css).toContain("font-family: 'Mycel Wordmark'");
    expect(css).toContain('font-display: swap');
    const fontResponse = await request.get(`/${slug}/_brand/font/1.woff2`);
    expect(fontResponse.status()).toBe(200);
    expect(fontResponse.headers()['content-type']).toBe('font/woff2');
    const activeEtag = (await request.get(`/${slug}/home`)).headers()['etag'];
    await expectNoAxeViolations(page);
    await page.goto(`/admin/${slug}/site?section=brand`);
    await page
      .locator('form[action$="&/brand"]')
      .first()
      .getByRole('button', { name: 'Remove' })
      .click();
    await expect(page.locator('[role="status"]')).toBeVisible();
    expect((await request.get(logoUrl!)).status()).toBe(404);
    const freshPage = await request.get(`/${slug}/home`, {
      headers: { 'if-none-match': activeEtag! },
    });
    expect(freshPage.status()).toBe(200);
    expect(freshPage.headers()['etag']).not.toBe(activeEtag);
    await page.goto(`/${slug}/home`);
    // A normal navigation may reuse the prior HTML inside the one-minute public freshness window;
    // reload revalidates the changed brand ETag, as a new visitor would.
    await page.reload();
    await expect(page.locator('.site-identity img')).toHaveCount(0);
    await expect(page.locator('.site-identity')).toContainText('Chrome fixture');
  });

  for (const [locale, language, title, actions] of [
    ['nl', 'nl-NL', 'Site-instellingen', ['Thema opslaan', 'Navigatie en voettekst opslaan']],
    ['en', 'en-US', 'Site settings', ['Save theme', 'Save navigation and footer']],
  ] as const) {
    test.describe(`${locale} admin site settings gate`, () => {
      test.use({ locale: language });

      test('keeps the real admin form accessible at 320 px and enlarged text', async ({ page }) => {
        await login(page, `/admin/${slug}/site?section=theme`, `site-editor-${slug}@probe.test`);
        await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('form[action$="&/theme"]')).toBeVisible();
        await uploadBrand(page);

        // Each subject is its own page (brief #56 settings pattern); every one passes the gate.
        for (const [section, action] of [
          ['theme', actions[0]],
          ['brand', null],
          ['chrome', actions[1]],
        ] as const) {
          await page.setViewportSize({ width: 320, height: 720 });
          await page.goto(`/admin/${slug}/site?section=${section}`);
          await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
          if (action)
            await expect(page.getByRole('button', { name: action, exact: true })).toBeVisible();
          else await expect(page.locator('button[value=remove]')).toHaveCount(2);
          const fontSize = await page.evaluate(() => {
            document.documentElement.style.fontSize = '200%';
            return parseFloat(getComputedStyle(document.documentElement).fontSize);
          });
          expect(fontSize).toBeGreaterThanOrEqual(32);

          await layoutGate(page, section, 'main');
          await page.setViewportSize({ width: 640, height: 720 });
          const zoomedActions = await page.evaluate(() => {
            document.documentElement.style.fontSize = '';
            document.documentElement.style.zoom = '2';
            const buttons = [
              ...document.querySelectorAll<HTMLElement>('main .ui-actions .ui-button'),
            ];
            const ok = buttons.every(
              (button) =>
                button.getBoundingClientRect().right <= innerWidth &&
                button.scrollWidth <= button.clientWidth
            );
            const overflow = document.documentElement.scrollWidth > innerWidth;
            document.documentElement.style.zoom = '';
            return { ok, overflow };
          });
          expect(zoomedActions.ok, section).toBe(true);
          expect(zoomedActions.overflow, section).toBe(false);
          await expectNoAxeViolations(page);
        }
      });
    });
  }
});

test('public profiles share policy across HTML, bylines and discovery', async ({ page }) => {
  await exercisePublicPeople(page);
});

test('authored people grids show teams without exposing internal email or unavailable links', async ({
  page,
}) => {
  await exercisePeopleGrid(page);
});
