// The route grammar, head and caching of a site (TODO #8c2, brief #8c § 8–10), on the dev path
// form and against the real stack: the locale is the path (no prefix for the default, a 404 for
// the default with one), articles live under `/articles/`, every page names its canonical URL
// and its published translations, published HTML is publicly cacheable with a strong ETag and a
// 304, no cookie is set, and misses are `no-store`. Then the JSON read route of the API process
// on the same seeded article.

import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';

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
  const api = process.env['E2E_API_URL'];
  test.skip(!api, 'run through scripts/e2e.mjs');
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
