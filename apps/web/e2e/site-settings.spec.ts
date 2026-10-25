// A complete bilingual site: tenant chrome and theme through real use cases and the public
// renderer, including the no-JavaScript/320 px/200% task gate (#11 E, ADR 009/013).
import AxeBuilder from '@axe-core/playwright';
import { Invoker, THEME_PRESETS, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createUnitOfWork, upsertTenant, uuidv7, uuidv7Ids } from '@mycel/db';
import { expect, test } from '@playwright/test';

const slug = `chrome-${Math.random().toString(36).slice(2, 8)}`;
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
      { id: uuidv7(), slug, name: 'Chrome fixture', defaultLocale: 'nl', locales: ['nl', 'en'] },
      { platformDomain: process.env['PLATFORM_DOMAIN']! }
    );
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
          { href: '/home', label: { nl: 'Welkom', en: 'Home' } },
          { href: '/en/home', label: { nl: 'English', en: 'English' } },
        ],
        footer: { nl: 'Een onafhankelijke site', en: 'An independent site' },
        legal: [
          {
            href: 'https://example.org/privacy',
            label: { nl: 'Privacyverklaring', en: 'Privacy policy' },
          },
        ],
        support: { href: 'https://example.org/support', label: { nl: 'Hulp', en: 'Support' } },
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

test('native site forms save theme and chrome with no JavaScript', async ({ page, request }) => {
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
  await page.locator('input[name="footer.nl"]').fill('Nieuwe voettekst');
  await page.locator('input[name="footer.en"]').fill('New footer');
  await page.locator('form[action="?/chrome"]').getByRole('button').click();
  await expect(page.locator('p[role="status"]')).toHaveText('Settings saved.');
  await page.reload();
  await expect(page.locator('input[name="footer.en"]')).toHaveValue('New footer');
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
