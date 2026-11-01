// flow: publish
// The versioned quality corpus is published by scripts/e2e/e2e.mjs through the same use cases as
// ordinary content. The manifest is an identity contract for #43B, not a second page renderer.
// Rejected: accepting a 200 from an empty shell, redirect or unrelated seeded page as a sample.
import AxeBuilder from '@axe-core/playwright';
import { THEME_PRESETS, Theme, UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import { expect, test } from '@playwright/test';
import corpus from './quality-corpus.json' with { type: 'json' };
import checklist from '../../../scripts/quality/spec-checklist.json' with { type: 'json' };
import { type Sample, specFailures } from '../../../scripts/quality/spec-check.mjs';
import { themeCss } from '../src/lib/theme/tokens.js';
import { WCAG, expectNoAxeViolations } from './lib/axe';
import { mobileInputProblems } from './lib/forms';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, layoutGate, setTextSize, setTextSpacing } from './lib/layout';
import { login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, requireApi } from './lib/api';

// Only the default set: scripts/e2e/e2e.mjs seeds the demo page and article under --quality alone,
// and the quality runner checks their identity itself (validateIdentity) in the demo scope. Same
// rule as publicNames(manifest, 'default') in scripts/quality/matrix.mjs.
// Rejected: seeding the demo content in every e2e run, which grows every list a spec counts.
const entries = Object.values(corpus.public).filter(
  (entry) => ((entry as { set?: string }).set ?? 'default') === 'default'
);
const qualityAdmin = 'quality-admin@probe.test';

test.beforeAll(async () => {
  const probe = await tenantId();
  await withInvoker(async (invoker) => {
    try {
      await invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
        email: qualityAdmin,
        capabilities: ['tenant:admin'],
      });
    } catch (error) {
      if (!(error instanceof UseCaseError && error.code === 'conflict')) throw error;
    }
  });
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
        if (isA11y()) {
          await img.scrollIntoViewIfNeeded();
          await expect
            .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth))
            .toBeGreaterThan(0);
        }
      }
      if (isA11y()) {
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

test.describe('quality corpus reflow and text spacing', () => {
  test.use({ viewport: NARROW });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: 320 CSS px, 200% text and WCAG spacing`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        await page.goto(identity.path);
        await setTextSpacing(page);
        await setTextSize(page, '200%');
        await layoutGate(page, `${entry.slug} ${locale} with WCAG text spacing`);
      });
  for (const entry of entries.filter((e) => (e.expected as { form?: boolean }).form))
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: form fields fit a phone keyboard`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        await page.goto(identity.path);
        expect(await mobileInputProblems(page)).toEqual([]);
      });
});

test.describe('validated demanding theme simulation', () => {
  test.use({ viewport: NARROW });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: editorial CSS keeps content and actions`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
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
        await setTextSize(page, '200%');
        await layoutGate(page, `${entry.slug} ${locale} with the editorial theme`);
        await expectNoAxeViolations(page);
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

// The gate items of scripts/quality/spec-checklist.json (specification.website) on the server's
// own responses: every corpus page in both locales, a revalidation, a missing path, a
// fingerprinted asset, the preloaded font and a page asked for in another language. Over the
// forwarded HTTPS scheme, as behind Caddy. The checklist file says which items are gated here,
// which an existing gate already covers and which are open.
test('public pages meet the gated items of the modern web checklist', async ({ request }) => {
  onlyA11y('reads raw HTTP responses, so one project is enough');
  const https = { 'x-forwarded-proto': 'https' };
  const sample = async (
    role: Sample['role'],
    path: string,
    headers: Record<string, string> = {},
    locale?: string
  ): Promise<Sample> => {
    const response = await request.get(path, {
      headers: { ...https, ...headers },
      maxRedirects: 0,
    });
    return {
      role,
      path,
      status: response.status(),
      headers: response.headers(),
      body: await response.text(),
      https: true,
      ...(locale ? { locale } : {}),
    };
  };
  const samples: Sample[] = [];
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales)) {
      const page = await sample('page', identity.path, {}, locale);
      samples.push(page);
      const etag = page.headers['etag'];
      if (etag)
        samples.push(await sample('revalidation', identity.path, { 'if-none-match': etag }));
      if (locale === 'nl')
        samples.push(await sample('negotiation', identity.path, { 'accept-language': 'en' }));
    }
  samples.push(await sample('missing', '/probe/spec-check-missing-page'));
  const first = samples[0]?.body ?? '';
  const asset = first.match(/href="([^"]*_app\/immutable\/[^"]+\.css)"/)?.[1];
  const font = first.match(/<link rel="preload" href="([^"]+)" as="font"/)?.[1];
  if (asset)
    samples.push(await sample('asset', new URL(asset, `http://x${samples[0]?.path}`).pathname));
  if (font) samples.push(await sample('font', font));
  expect(specFailures(checklist, samples)).toEqual([]);
});

test('admin corpus uses the populated shell, native editor and enhanced writer', async ({
  page,
  request,
}) => {
  requireApi();
  const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
    type: 'article',
    slug: corpus.public.article.slug,
  });
  expect(items).toHaveLength(1);
  const id = items[0]!.id;
  await login(page, '/admin/probe/content', qualityAdmin);
  await expect(page.locator('#content-table tbody tr')).not.toHaveCount(0);
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  await page.goto(`/admin/probe/content/${id}`);
  await expect(page.locator('#title\\.nl')).toHaveValue('De straat die ruimte maakt');
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.writerCspViolations = [];
    window.addEventListener('securitypolicyviolation', (event) => {
      window.writerCspViolations.push(
        `${event.violatedDirective}: ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`
      );
    });
  });
  await page.goto(`/admin/probe/content/${id}/write`);
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  if (isA11y()) await expect(page.locator('.writing-surface .ProseMirror')).toBeVisible();
  else {
    await expect(page).toHaveURL(`/admin/probe/content/${id}#blocks`);
    await expect(page.locator('#item-edit')).toHaveCount(1);
    const prose = page.locator('[data-native-prose] details.block').first();
    await prose.locator(':scope > summary').click();
    await expect(prose.locator('textarea').first()).toBeVisible();
  }
  if (isA11y()) {
    const writing = page.locator('.writing-surface .ProseMirror');
    expect((await writing.innerText()).trim().split(/\s+/u).length).toBeGreaterThanOrEqual(
      corpus.public.article.expected.minWords
    );
    await expect(writing).toHaveAttribute('contenteditable', 'true');
    await writing.locator('.editor-prose p').first().click();
    await writing.press('ArrowRight');
    expect(await page.evaluate(() => window.writerCspViolations)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});
