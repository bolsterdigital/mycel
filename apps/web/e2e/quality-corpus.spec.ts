// The versioned quality corpus is published by scripts/e2e.mjs through the same use cases as
// ordinary content. The manifest is an identity contract for #43B, not a second page renderer.
// Rejected: accepting a 200 from an empty shell, redirect or unrelated seeded page as a sample.
import AxeBuilder from '@axe-core/playwright';
import {
  Invoker,
  THEME_PRESETS,
  Theme,
  UseCaseError,
  buildRegistry,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } from '@mycel/db';
import { expect, test, type Page } from '@playwright/test';
import corpus from './quality-corpus.json' with { type: 'json' };
import { themeCss } from '../src/lib/theme/tokens.js';

const entries = Object.values(corpus.public);
const WCAG = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'];
const qualityAdmin = 'quality-admin@probe.test';

test.beforeAll(async () => {
  const owner = createDb(process.env['DATABASE_URL']!);
  const app = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const probe = await createTenantDirectory(owner).findBySlug('probe');
    if (!probe) throw new Error('probe tenant missing');
    const uow = createUnitOfWork(app, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
    const invoker = new Invoker(buildRegistry(), uow);
    try {
      await invoker.run(useCases.inviteMember, systemPrincipal(probe.id, 'e2e'), {
        email: qualityAdmin,
        capabilities: ['tenant:admin'],
      });
    } catch (error) {
      if (!(error instanceof UseCaseError && error.code === 'conflict')) throw error;
    }
  } finally {
    await app.destroy();
    await owner.destroy();
  }
});

test.use({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

for (const entry of entries)
  for (const [locale, identity] of Object.entries(entry.locales))
    test(`${entry.slug} ${locale}: published identity, content and resources`, async ({ page }) => {
      const failed: string[] = [];
      const foreign: string[] = [];
      const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173').origin;
      page.on('requestfailed', (request) => failed.push(request.url()));
      page.on('request', (request) => {
        if (new URL(request.url()).origin !== origin) foreign.push(request.url());
      });
      const response = await page.goto(identity.path, { waitUntil: 'load' });
      expect(response?.status()).toBe(entry.expected.status);
      expect(new URL(page.url()).pathname).toBe(identity.path);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(identity.title);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(
          `${locale === 'en' ? '/en' : ''}/${entry.routeClass === 'article' ? 'articles/' : ''}${entry.slug}$`
        )
      );
      await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
      await expect(page.locator('link[rel="stylesheet"][href*="/_theme/"]')).toHaveCount(1);
      await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(1);
      expect(await page.locator('main img').count()).toBeGreaterThanOrEqual(
        entry.expected.minImages
      );
      if (entry.routeClass === 'article' && 'minWords' in entry.expected) {
        const words = (await page.locator('main').innerText()).trim().split(/\s+/u);
        expect(words.length).toBeGreaterThanOrEqual(entry.expected.minWords);
        await expect(page.locator('main h2')).not.toHaveCount(0);
        await expect(page.locator('main ul')).not.toHaveCount(0);
        await expect(page.locator('main ol')).not.toHaveCount(0);
        await expect(page.locator('main blockquote')).not.toHaveCount(0);
        await expect(page.locator('main a[href]')).not.toHaveCount(0);
      } else if ('form' in entry.expected) {
        await expect(page.locator('main form[method="post"]')).toHaveCount(
          entry.expected.form ? 1 : 0
        );
      }
      if ('closingProse' in entry.expected) {
        await expect(page.locator('main .hero')).toHaveCount(0);
        expect(await page.locator('main .rich-text').count()).toBeGreaterThanOrEqual(
          entry.expected.minProseBlocks
        );
        const prose = page.locator('main > .rich-text');
        await expect(prose.last()).toHaveText((await prose.first().textContent())!);
        await expect(page.locator('main > :last-child')).toHaveClass(/rich-text/);
      }
      for (const img of await page.locator('main img').all()) {
        await expect(img).toHaveAttribute('width', /\d+/);
        await expect(img).toHaveAttribute('height', /\d+/);
        if (test.info().project.name === 'a11y') {
          await img.scrollIntoViewIfNeeded();
          await expect
            .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth))
            .toBeGreaterThan(0);
        }
      }
      if (test.info().project.name === 'a11y') {
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family.includes('Inter') && font.status === 'loaded'
            )
          )
        ).toBe(true);
        const { violations, incomplete } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
        expect(violations.map((violation) => violation.id)).toEqual([]);
        // A photo-backed hero is an axe contrast manual-review case (bgOverlap). Preserve
        // the result as evidence; a new kind of serious incomplete must fail this gate.
        await test.info().attach('axe-incomplete.json', {
          body: JSON.stringify(incomplete),
          contentType: 'application/json',
        });
        expect(
          incomplete
            .filter((result) => result.impact === 'serious' || result.impact === 'critical')
            .filter((result) => result.id !== 'color-contrast')
            .map((result) => result.id)
        ).toEqual([]);
      }
      expect(failed).toEqual([]);
      expect(foreign).toEqual([]);
    });

async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const errors: string[] = [];
    const width = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > width + 1) errors.push('viewport overflow');
    for (const element of document.querySelectorAll(
      '.actions a, .actions button, main form button'
    )) {
      const box = element.getBoundingClientRect();
      if (box.width < 44 || box.height < 44)
        errors.push(`small target: ${element.textContent?.trim()}`);
      if (
        element.scrollWidth > element.clientWidth + 1 ||
        element.scrollHeight > element.clientHeight + 1
      )
        errors.push(`clipped: ${element.textContent?.trim()}`);
    }
    return errors;
  });
}

test.describe('quality corpus reflow and text spacing', () => {
  test.use({ viewport: { width: 320, height: 900 } });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: 320 CSS px, 200% text and WCAG spacing`, async ({ page }) => {
        test.skip(test.info().project.name !== 'a11y', 'requires DOM measurements');
        await page.goto(identity.path);
        await page.evaluate(() => {
          // Constructable user stylesheet leaves the page's strict CSP untouched.
          const sheet = new CSSStyleSheet();
          sheet.replaceSync(
            '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
          );
          document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        });
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        expect(await layoutProblems(page)).toEqual([]);
        await page.screenshot({
          path: test.info().outputPath(`${entry.routeClass}-${locale}-320-200-spacing.png`),
          fullPage: true,
        });
      });
});

test.describe('validated demanding theme simulation', () => {
  test.use({ viewport: { width: 320, height: 900 } });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: editorial CSS keeps content and actions`, async ({ page }) => {
        test.skip(test.info().project.name !== 'a11y', 'requires DOM measurements');
        const editorial = Theme.parse(THEME_PRESETS.editorial);
        await page.route('**/_theme/*.css', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: themeCss(editorial) });
        });
        const response = await page.goto(identity.path);
        expect(response?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(identity.title);
        await expect(page.locator('body')).toHaveCSS('font-family', /Inter/);
        await expect(page.locator('h1')).toHaveCSS('font-family', /Mycel Serif/);
        await page.evaluate(() => {
          document.documentElement.style.fontSize = '200%';
        });
        expect(await layoutProblems(page)).toEqual([]);
        const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
        expect(violations.map((violation) => violation.id)).toEqual([]);
      });
});

test('campaign accordion and task link work with keyboard only', async ({ page }) => {
  await page.goto(corpus.public.campaign.locales.nl.path);
  const summary = page.locator('main details summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).not.toHaveAttribute('open', '');
  const link = page.getByRole('link', { name: 'Teken de petitie' }).first();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/probe\/signup$/);
});

test('admin corpus uses the populated shell, native editor and enhanced writer', async ({
  page,
  request,
}) => {
  test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
  const listed = await request.post(`${process.env['E2E_API_URL']}/v1/content.item.list`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data: { type: 'article', slug: corpus.public.article.slug },
  });
  expect(listed.ok(), await listed.text()).toBe(true);
  const { items } = (await listed.json()) as { items: { id: string }[] };
  expect(items).toHaveLength(1);
  const id = items[0]!.id;
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `2001:db8:43::${Math.floor(Math.random() * 0xffff).toString(16)}`,
  });
  await page.goto('/admin/probe/content');
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(qualityAdmin);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content$/);
  await expect(page.locator('.content-list li')).not.toHaveCount(0);
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  await page.goto(`/admin/probe/content/${id}`);
  await expect(page.getByRole('main')).toContainText('De straat die ruimte maakt');
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  await page.goto(`/admin/probe/content/${id}/write`);
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  if (test.info().project.name === 'a11y')
    await expect(page.locator('.writing-surface .ProseMirror')).toBeVisible();
  else
    await expect(
      page.getByRole('link', { name: /without JavaScript|zonder JavaScript/i })
    ).toHaveAttribute('href', `/admin/probe/content/${id}`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});
