// The site search over a restricted article (brief site-search § B, ADR 016 rule 3), on the
// site's own hostname where the reader cookie lives. Run from the restricted-article flow
// (restricted.ts), which brings the article, the sign-in and the grant: a question that needs a
// word from behind the boundary finds the article only for the reader whose grant opens it, with
// the match marked in an excerpt from the body; a visitor finds it by its title, marked "Voor
// leden", with the teaser as excerpt and nothing from behind the boundary. A visitor's answer is
// public and varies on the cookie; a reader's is theirs alone. The access matrix is
// packages/db/src/reader-search.test.ts; the visitor's page with a restricted result passes axe and
// the layout gate in search.ts.

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from '../layout';

const SITE = 'http://probe.localhost:4173';
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=600';

const searchUrl = (q: string) => `${SITE}/search?${new URLSearchParams({ q })}`;

/**
 * As a visitor: the article is found by `title`, the token its title carries, and not by
 * `title body`, where `body` stands only behind the boundary. `hidden` never shows.
 */
export async function visitorSearch(
  request: APIRequestContext,
  title: string,
  body: string,
  hidden: readonly string[]
) {
  const found = await request.get(searchUrl(title));
  const html = await found.text();
  expect(found.headers()['cache-control']).toBe(PUBLIC_CACHE);
  expect(found.headers()['vary']?.toLowerCase()).toContain('cookie');
  expect(html).toMatch(/class="overview-access"[^>]*>\s*Voor leden\s*</);
  expect(html).toContain('De lead mag iedereen lezen.');
  expect(hidden.filter((s) => html.includes(s))).toEqual([]);
  const behind = await (await request.get(searchUrl(`${title} ${body}`))).text();
  expect(behind).toContain('class="search-empty"');
}

/**
 * As the signed-in reader of `page`: with `open` the article is found by `title body`, the body
 * word marked in the excerpt; without, nothing is. The answer is private either way. With `gate`,
 * axe and the layout gate at 320 CSS px in every text size (kept out of the short grant window).
 */
export async function readerSearch(
  page: Page,
  title: string,
  body: string,
  { open, gate = false }: { open: boolean; gate?: boolean }
) {
  const response = await page.goto(searchUrl(`${title} ${body}`));
  expect(response?.headers()['cache-control']).toBe('private, no-store');
  expect(response?.headers()['vary']?.toLowerCase()).toContain('cookie');
  expect(response?.headers()['etag']).toBeUndefined();
  const results = page.locator('.search-results > li');
  if (open) {
    await expect(results).toHaveCount(1);
    await expect(results.locator('.overview-access')).toHaveText('Voor leden');
    await expect(results.locator('mark')).toHaveText(new RegExp(`^${body}$`, 'i'));
  } else await expect(results).toHaveCount(0);
  if (!gate) return;
  await expectNoAxeViolations(page, { label: 'reader search', dark: true });
  const wide = page.viewportSize()!;
  await page.setViewportSize(NARROW);
  for (const size of TEXT_SIZES) {
    await setTextSize(page, size);
    await layoutGate(page, `reader search at 320px / ${size}`, 'main');
  }
  await setTextSize(page, '16px');
  await page.setViewportSize(wide);
}
