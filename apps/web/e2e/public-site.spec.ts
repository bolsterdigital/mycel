// flow: publish
// What a visitor gets from a published site: composed block pages, the route grammar with its
// head and caching, grid compositions, and a site's chrome and theme from its settings. Each part
// below was a spec of its own until TODO #50 folded the suite to its budget (testing.md
// § End-to-end flows); each keeps its own fixtures.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ContentDocument, THEME_PRESETS, systemPrincipal, useCases } from '@mycel/core';
import { upsertTenant, uuidv7 } from '@mycel/db';
import { type APIRequestContext, type Page, chromium, expect, test } from '@playwright/test';
import sharp from 'sharp';
import { expectNoAxeViolations } from './lib/axe';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, requireApi } from './lib/api';

// The block renderer on two composed pages (TODO #8c1, brief #8c § 5), seeded by scripts/e2e.mjs
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
        expect(measured.title!.width).toBeCloseTo(measured.prose!.width, 0);
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
      await page.getByLabel('E-mail').fill('e2e-admin@probe.test');
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(new RegExp(`/content/${saved.item.id}$`));
      const edit = page.url();
      const href = await page.getByRole('link', { name: /Voorbeeld \(nl\)/ }).getAttribute('href');
      await page.goto(href!);
      const savedMetrics = await metrics(page);
      expect(savedMetrics.overflow).toBe(false);
      expect(savedMetrics.prose!.width).toBeGreaterThanOrEqual(680);
      expect(savedMetrics.title!.width).toBeCloseTo(savedMetrics.prose!.width, 0);
      await page.goto(edit);
      if (entry.type === 'article') {
        // The article writer has no automatic live-preview panel yet. Exercise the real
        // unsaved-document route with the unchanged native metadata form; this proves the
        // renderer, not a missing writer interaction (which remains owned by #11).
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
        }, saved.item.id);
        await expect(page.locator('main h1')).toHaveText(entry.title);
        const draft = await metrics(page);
        expect(draft.overflow).toBe(false);
        expect(draft.prose!.width).toBeCloseTo(savedMetrics.prose!.width, 0);
        await test.info().attach('article-draft-rails.json', {
          body: JSON.stringify({ saved: savedMetrics, draft, writerLivePanel: 'not-implemented' }),
          contentType: 'application/json',
        });
        return;
      }
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
          title: title.width,
          overflow: main.ownerDocument.documentElement.scrollWidth > width + 1,
        };
      });
      expect(live.overflow).toBe(false);
      expect(live.title).toBeCloseTo(live.prose, 0);
      await test.info().attach('preview-rails.json', {
        body: JSON.stringify({ saved: savedMetrics, live }),
        contentType: 'application/json',
      });
      await page.setViewportSize({ width: live.width, height: 900 });
      await page.goto(`/probe/${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`);
      expect((await metrics(page)).prose!.width).toBeCloseTo(live.prose, 0);
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
  test('real Chromium 200% browser zoom reflows the composition', async () => {
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
      expect(after.title!.width).toBeCloseTo(after.prose!.width, 0);
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
          if (spacing)
            await page.evaluate(() => {
              // Constructable user stylesheet leaves the page's strict CSP untouched.
              const sheet = new CSSStyleSheet();
              sheet.replaceSync(
                '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
              );
              document.adoptedStyleSheets.push(sheet);
            });
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
      await upsertTenant(
        owner,
        {
          id: uuidv7(),
          slug,
          name: 'Chrome fixture',
          defaultLocale: 'nl',
          locales: ['nl', 'en', 'de'],
        },
        { platformDomain: process.env['PLATFORM_DOMAIN']! }
      ),
      await upsertTenant(
        owner,
        {
          id: uuidv7(),
          slug: singleSlug,
          name: 'Single-locale fixture',
          defaultLocale: 'nl',
          locales: ['nl'],
        },
        { platformDomain: process.env['PLATFORM_DOMAIN']! }
      ),
    ]);
    tenantId = tenant.id;
    singleTenantId = singleTenant.id;
    await withInvoker(async (invoker) => {
      const principal = systemPrincipal(tenant.id, 'e2e');
      await invoker.run(useCases.inviteMember, principal, {
        email: `site-editor-${slug}@probe.test`,
        capabilities: ['content:write', 'content:read'],
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
        theme: THEME_PRESETS.editorial,
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

  test('native site forms preserve locales and reject stale changes', async ({
    page,
    request,
    context,
  }) => {
    await page.goto(`/${slug}/home`);
    const oldCss = await page
      .locator('link[rel=stylesheet][href*="/_theme/"]')
      .getAttribute('href');
    await login(page, `/admin/${slug}/site`, `site-editor-${slug}@probe.test`);
    await page.locator('select[name="fontPair"]').selectOption('inter');
    await page.locator('form[action$="&/theme"]').getByRole('button').click();
    await expect(page.locator('[role="status"]')).toHaveText('Settings saved.');
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
        await login(page, `/admin/${slug}/site`, `site-editor-${slug}@probe.test`);
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
