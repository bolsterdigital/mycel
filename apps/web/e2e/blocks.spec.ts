// The block renderer on two composed pages (TODO #8c1, brief #8c § 5), seeded by scripts/e2e.mjs
// from the registry's own examples: `campagne` (hero cover, rich text, cta card, wide image, FAQ
// accordion, form card) and `artikel` (hero split, rich text with headings and a footnote,
// pullquote, floated image, warning callout, video link), each in nl and en. Per page and
// locale: axe clean, readable and usable without JavaScript, no script at all, fonts and images
// from the site's own origin, no CSP violation. Then the UI gate of skill ui-action-layout for
// the hero and cta action groups at 320 CSS px and 200% text, and one run each with reduced
// motion and the dark palette.

import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';

const PAGES = {
  campagne: { nl: 'Schone lucht, nu', en: 'Clean air, now' },
  artikel: { nl: 'Een straat vol bomen', en: 'A street full of trees' },
} as const;

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
        // Only a form's own proof-of-work module (brief form-intake § D2.3).
        expect(await page.locator('script:not([src="/_form/proof.js"])').count()).toBe(0);
        expect(await page.locator('[style]').count()).toBe(0);
        // Every image is sized and comes from the site; the theme is a linked stylesheet.
        for (const img of await page.locator('main img').all()) {
          await expect(img).toHaveAttribute('width', /\d+/);
          await expect(img).toHaveAttribute('height', /\d+/);
          await expect(img).toHaveAttribute('alt', /.*/);
        }
        await expect(page.locator('link[rel="stylesheet"][href*="/_theme/"]')).toHaveCount(1);
        await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(1);
        if (test.info().project.name === 'a11y') {
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
  const href = await page.locator('link[rel="stylesheet"][href*="/_theme/"]').getAttribute('href');
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
    await expect(page.locator('form[method="post"] button[type="submit"]')).toHaveText('Aanmelden');
    await expect(page.getByRole('link', { name: 'Teken de petitie' }).first()).toHaveAttribute(
      'href',
      '/probe/signup'
    );
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

test.describe('UI gate: hero and cta action groups at 320 CSS px and 200% text', () => {
  test.use({ viewport: NARROW, locale: 'nl-NL' });

  for (const slug of ['campagne', 'artikel'])
    for (const text of TEXT_SIZES)
      test(`${slug}: every action whole, stacked when needed, no horizontal scroll, text ${text}`, async ({
        page,
      }) => {
        test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
        await open(page, `/probe/${slug}`);
        await setTextSize(page, text);
        await layoutGate(page, slug);
      });
});

test.describe('user preferences', () => {
  test.use({ locale: 'nl-NL' });

  test('reduced motion turns every transition off', async ({ page }) => {
    test.skip(test.info().project.name !== 'a11y', 'reads computed styles with a script');
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
    test.skip(test.info().project.name !== 'a11y', 'axe runs as a script');
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
