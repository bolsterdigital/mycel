// A complete bilingual site: tenant chrome and theme through real use cases and the public
// renderer, including the no-JavaScript/320 px/200% task gate (#11 E, ADR 009/013).
import AxeBuilder from '@axe-core/playwright';
import { readFile } from 'node:fs/promises';
import { Invoker, THEME_PRESETS, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createUnitOfWork, upsertTenant, uuidv7, uuidv7Ids } from '@mycel/db';
import { expect, test } from '@playwright/test';

const slug = `chrome-${Math.random().toString(36).slice(2, 8)}`;
const singleSlug = `chrome-single-${Math.random().toString(36).slice(2, 8)}`;
let tenantId = '';
let singleTenantId = '';
let homeItemId = '';
const chromeState = async (id: string) => {
  const app = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const invoker = new Invoker(
      buildRegistry(),
      createUnitOfWork(app, {
        clock: { now: () => new Date() },
        ids: uuidv7Ids,
        signer: new FakeSigner(),
        inputHasher: new FakeInputHasher(),
        dns: new FakeDns(),
        platform: memoryPlatform,
      })
    );
    return await invoker.run(useCases.getSiteChrome, systemPrincipal(id, 'e2e'), {});
  } finally {
    await app.destroy();
  }
};
test.use({
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
  viewport: { width: 320, height: 720 },
});
test.beforeAll(async () => {
  const owner = createDb(process.env['DATABASE_URL']!);
  const app = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const tenant = await upsertTenant(
      owner,
      {
        id: uuidv7(),
        slug,
        name: 'Chrome fixture',
        defaultLocale: 'nl',
        locales: ['nl', 'en', 'de'],
      },
      { platformDomain: process.env['PLATFORM_DOMAIN']! }
    );
    tenantId = tenant.id;
    const singleTenant = await upsertTenant(
      owner,
      {
        id: uuidv7(),
        slug: singleSlug,
        name: 'Single-locale fixture',
        defaultLocale: 'nl',
        locales: ['nl'],
      },
      { platformDomain: process.env['PLATFORM_DOMAIN']! }
    );
    singleTenantId = singleTenant.id;
    const invoker = new Invoker(
      buildRegistry(),
      createUnitOfWork(app, {
        clock: { now: () => new Date() },
        ids: uuidv7Ids,
        signer: new FakeSigner(),
        inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
        dns: new FakeDns(),
        platform: memoryPlatform,
      })
    );
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
        help: { href: 'https://example.org/help', label: { nl: 'Vraag', en: 'Help', de: 'Hilfe' } },
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
  } finally {
    await app.destroy();
    await owner.destroy();
  }
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
    if (test.info().project.name === 'a11y') {
      const { violations } = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(violations.map((violation) => violation.id)).toEqual([]);
    }
  });

test('native site forms preserve locales and reject stale changes', async ({
  page,
  request,
  context,
}) => {
  await page.goto(`/${slug}/home`);
  const oldCss = await page.locator('link[rel=stylesheet][href*="/_theme/"]').getAttribute('href');
  await page.goto(`/admin/${slug}/site`);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(`site-editor-${slug}@probe.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`/admin/${slug}/site$`));
  await page.locator('select[name="fontPair"]').selectOption('inter');
  await page.locator('form[action="?/theme"]').getByRole('button').click();
  await expect(page.locator('p[role="status"]')).toHaveText('Settings saved.');
  const stalePage = await context.newPage();
  await stalePage.goto(`/admin/${slug}/site`);
  await page.locator('input[name="footer.en"]').fill('New footer');
  await page.locator('form[action="?/chrome"]').getByRole('button').click();
  await expect(page.locator('p[role="status"]')).toHaveText('Settings saved.');
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
  await stalePage.locator('form[action="?/chrome"]').getByRole('button').click();
  await expect(stalePage.locator('p[role="alert"]')).toBeVisible();
  expect((await chromeState(tenantId)).value.footer.en).toBe('New footer');
  await page.goto(`/admin/${slug}/site`);
  await expect(page.locator('input[name="footer.en"]')).toHaveValue('New footer');
  await expect(page.locator('input[name="footer.de"]')).toHaveValue('Eine unabhängige Website');
  await page.locator('input[name="footer.de"]').fill('');
  await page.locator('input[name="help.href"]').fill('');
  await page.locator('form[action="?/chrome"]').getByRole('button').click();
  await expect(page.locator('p[role="status"]')).toHaveText('Settings saved.');
  saved = await chromeState(tenantId);
  expect(saved.value.footer.de).toBeUndefined();
  expect(saved.value.help).toBeNull();
  expect(saved.value.legal[0]?.label.de).toBe('Datenschutz');
  await page.goto(`/${slug}/en/home`);
  await expect(page.getByRole('contentinfo')).toContainText('New footer');
  const newCss = await page.locator('link[rel=stylesheet][href*="/_theme/"]').getAttribute('href');
  expect(newCss).not.toBe(oldCss);
  const stale = await request.get(oldCss!, { maxRedirects: 0 });
  expect(stale.status()).toBe(302);
  expect(stale.headers()['location']).toBe(newCss);
  expect(stale.headers()['cache-control']).toBe('no-store');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (test.info().project.name === 'a11y') {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations.map((violation) => violation.id)).toEqual([]);
  }
});

test('single-locale site saves without another translation', async ({ page }) => {
  await page.goto(`/admin/${singleSlug}/site`);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(`site-editor-${singleSlug}@probe.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('input[name="footer.nl"]')).toHaveValue('Een taal');
  await expect(page.locator('input[name="footer.en"]')).toHaveCount(0);
  await page.locator('input[name="footer.nl"]').fill('Nieuwe tekst');
  await page.locator('form[action="?/chrome"]').getByRole('button').click();
  await expect(page.locator('p[role="status"]')).toBeVisible();
  expect((await chromeState(singleTenantId)).value.footer).toEqual({ nl: 'Nieuwe tekst' });
});

test('native brand upload, public derivative and removal stay tenant scoped', async ({
  page,
  request,
}) => {
  await page.goto(`/admin/${slug}/site`);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(`site-editor-${slug}@probe.test`);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const logo = page.locator('form[action="?/brand"]').first();
  await logo.locator('input[type=file]').setInputFiles({
    name: 'mark.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#123456"/></svg>'
    ),
  });
  await logo.getByRole('button', { name: 'Upload' }).click();
  await expect(page.locator('p[role="status"]')).toBeVisible();
  const font = page.locator('form[action="?/brand"]').last();
  await font.locator('input[type=file]').setInputFiles({
    name: 'inter.woff2',
    mimeType: 'font/woff2',
    buffer: await readFile(
      new URL('../static/fonts/inter/inter-latin-roman.woff2', import.meta.url)
    ),
  });
  await font.locator('input[name=licence]').fill('SIL Open Font License 1.1');
  await font.getByRole('button', { name: 'Upload' }).click();
  await expect(page.locator('p[role="status"]')).toBeVisible();

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
  if (test.info().project.name === 'a11y') {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations.map((violation) => violation.id)).toEqual([]);
  }
  await page.goto(`/admin/${slug}/site`);
  await page
    .locator('form[action="?/brand"]')
    .first()
    .getByRole('button', { name: 'Remove' })
    .click();
  await expect(page.locator('p[role="status"]')).toBeVisible();
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
      await page.goto(`/admin/${slug}/site`);
      await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
      await page.getByLabel('E-mail').fill(`site-editor-${slug}@probe.test`);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/${slug}/site$`));
      await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.locator('form[action="?/theme"]')).toBeVisible();
      await expect(page.locator('form[action="?/chrome"]')).toBeVisible();

      const buttons = actions.map((name) => page.getByRole('button', { name, exact: true }));
      for (const button of buttons) await expect(button).toBeVisible();
      const fontSize = await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
        return parseFloat(getComputedStyle(document.documentElement).fontSize);
      });
      expect(fontSize).toBeGreaterThanOrEqual(32);

      const layout = await page.evaluate(() => {
        const controls = [
          ...document.querySelectorAll<HTMLElement>(
            '.admin-page input:not([type="hidden"]), .admin-page select, .admin-page textarea, .admin-page button'
          ),
        ];
        const labels = [...document.querySelectorAll<HTMLElement>('.admin-page label')];
        return {
          viewport: innerWidth,
          document: document.documentElement.scrollWidth,
          controls: controls.map((node) => ({
            name: node.getAttribute('name') ?? node.textContent?.trim() ?? '',
            width: node.getBoundingClientRect().width,
            height: node.getBoundingClientRect().height,
            right: node.getBoundingClientRect().right,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          })),
          labels: labels.map((node) => ({
            text: node.textContent?.trim() ?? '',
            right: node.getBoundingClientRect().right,
            scrollWidth: node.scrollWidth,
            clientWidth: node.clientWidth,
          })),
          overflowing: [...document.querySelectorAll<HTMLElement>('.admin-page *')]
            .filter((node) => node.getBoundingClientRect().right > innerWidth)
            .map((node) => ({
              tag: node.tagName,
              className: node.className,
              text: node.textContent?.trim().slice(0, 80),
              right: node.getBoundingClientRect().right,
            }))
            .slice(0, 10),
        };
      });
      expect(layout.document, JSON.stringify(layout.overflowing)).toBeLessThanOrEqual(
        layout.viewport
      );
      for (const control of layout.controls) {
        expect(control.width, control.name).toBeGreaterThanOrEqual(44);
        expect(control.height, control.name).toBeGreaterThanOrEqual(44);
        expect(control.right, control.name).toBeLessThanOrEqual(layout.viewport);
        expect(control.scrollWidth, control.name).toBeLessThanOrEqual(control.clientWidth);
      }
      for (const label of layout.labels) {
        expect(label.right, label.text).toBeLessThanOrEqual(layout.viewport);
        expect(label.scrollWidth, label.text).toBeLessThanOrEqual(label.clientWidth);
      }
      await page.setViewportSize({ width: 640, height: 720 });
      const zoomedActions = await page.evaluate(() => {
        document.documentElement.style.fontSize = '';
        document.documentElement.style.zoom = '2';
        const actions = [...document.querySelectorAll<HTMLElement>('.brand-actions button')];
        const ok = actions.every(
          (button) =>
            button.getBoundingClientRect().right <= innerWidth &&
            button.scrollWidth <= button.clientWidth
        );
        const overflow = document.documentElement.scrollWidth > innerWidth;
        document.documentElement.style.zoom = '';
        return { ok, overflow };
      });
      expect(zoomedActions.ok).toBe(true);
      expect(zoomedActions.overflow).toBe(false);
      await page.setViewportSize({ width: 320, height: 720 });
      await page.evaluate(() => {
        document.documentElement.style.fontSize = '200%';
      });
      await page.screenshot({
        path: test.info().outputPath(`site-settings-${locale}-320-text-200.png`),
        fullPage: true,
      });
      if (test.info().project.name === 'a11y') {
        const { violations } = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(violations.map((violation) => violation.id)).toEqual([]);
      }
      await expect(page).toHaveURL(new RegExp(`/admin/${slug}/site$`));
    });
  });
}
