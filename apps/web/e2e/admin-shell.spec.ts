// The tenant shell is one navigation surface across routes, locales and site memberships.
// A second, empty site catches stale site names and links when changing tenants.
import AxeBuilder from '@axe-core/playwright';
import { Invoker, UseCaseError, buildRegistry, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import {
  createDb,
  createTenantDirectory,
  createUnitOfWork,
  upsertTenant,
  uuidv7Ids,
} from '@mycel/db';
import { expect, test, type Page } from '@playwright/test';

const email = 'shell-admin@probe.test';
const other = 'shell-other';

test.beforeAll(async () => {
  const owner = createDb(process.env['DATABASE_URL']!);
  const probe = await createTenantDirectory(owner).findBySlug('probe');
  if (!probe) throw new Error('probe tenant missing');
  const tenant = await upsertTenant(
    owner,
    {
      id: crypto.randomUUID(),
      slug: other,
      name: 'Second editorial site',
      defaultLocale: 'en',
      locales: ['en', 'nl'],
    },
    { platformDomain: process.env['PLATFORM_DOMAIN']! }
  );
  const app = createDb(process.env['APP_DATABASE_URL']!);
  const uow = createUnitOfWork(app, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
    dns: new FakeDns(),
    platform: memoryPlatform,
  });
  try {
    const invoker = new Invoker(buildRegistry(), uow);
    for (const site of [probe, tenant]) {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(site.id, 'e2e'), {
          email,
          capabilities: ['tenant:admin'],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    }
  } finally {
    await app.destroy();
    await owner.destroy();
  }
});

async function login(page: Page) {
  await page.context().setExtraHTTPHeaders({
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `2001:db8:44::${Math.floor(Math.random() * 0xffffffff).toString(16)}`,
  });
  await page.goto('/admin/probe');
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/probe$/);
}

async function checkShell(page: Page, name: string, current: string) {
  await expect(page.locator('.admin-site-name')).toHaveText(name);
  await expect(
    page
      .getByRole('navigation', { name: /sitenavigatie|site navigation/i })
      .getByRole('link', { name: current })
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main')).toHaveCount(1);
  if (test.info().project.name === 'a11y') {
    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  } else {
    const scripts = await page
      .locator('script')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ src: node.getAttribute('src'), type: node.getAttribute('type') }))
      );
    // The content editor's optional module is inert in this project; the native edit flow
    // remains the no-JS contract. Other shell routes still emit no script.
    expect(scripts).toEqual(
      /\/content\/[^/]+$/.test(new URL(page.url()).pathname)
        ? [{ src: '/_admin/live-preview-parent.js', type: 'module' }]
        : []
    );
  }
}

test('site navigation persists through content, editor, media, settings and a second tenant', async ({
  page,
}) => {
  await login(page);
  await checkShell(page, 'Probe', 'Overview');
  await page.screenshot({ path: test.info().outputPath('overview-wide.png'), fullPage: true });
  await page
    .getByRole('navigation', { name: 'Site navigation' })
    .getByRole('link', { name: 'Pages and articles' })
    .click();
  await checkShell(page, 'Probe', 'Pages and articles');
  await expect(page.locator('.content-list li').first()).toBeVisible();
  await page.locator('.content-list li a').first().click();
  await checkShell(page, 'Probe', 'Pages and articles');
  await page.screenshot({ path: test.info().outputPath('editor-wide.png'), fullPage: true });
  await page
    .getByRole('navigation', { name: 'Site navigation' })
    .getByRole('link', { name: 'Manage media' })
    .click();
  await checkShell(page, 'Probe', 'Manage media');
  await page
    .getByRole('navigation', { name: 'Site navigation' })
    .getByRole('link', { name: 'Site settings' })
    .click();
  await expect(page).toHaveURL(/\/admin\/probe\/site$/);
  await page.getByRole('link', { name: 'Back to your sites' }).click();
  await page.getByRole('main').getByRole('link', { name: 'Second editorial site' }).click();
  await checkShell(page, 'Second editorial site', 'Overview');
  await page
    .getByRole('navigation', { name: 'Site navigation' })
    .getByRole('link', { name: 'Pages and articles' })
    .click();
  await expect(page.locator('.content-list li')).toHaveCount(0);
  await checkShell(page, 'Second editorial site', 'Pages and articles');
  await expect(page.locator('body')).not.toContainText('Probe');
});

test.describe('narrow navigation and action labels', () => {
  test.use({ viewport: { width: 320, height: 900 } });
  test('works with keyboard and at 200% text', async ({ page }) => {
    await login(page);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    const menu = page.getByText('Menu', { exact: true });
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await expect(page.locator('.admin-menu')).toHaveAttribute('open');
    const problems = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      const errors: string[] = [];
      if (document.documentElement.scrollWidth > width) errors.push('horizontal overflow');
      for (const node of document.querySelectorAll(
        '.admin-sidebar a, .admin-sidebar button, .admin-menu summary'
      )) {
        const box = node.getBoundingClientRect();
        if (box.width < 44 || box.height < 44) errors.push(`small target: ${node.textContent}`);
        if (node.scrollWidth > node.clientWidth + 1)
          errors.push(`clipped label: ${node.textContent}`);
      }
      return errors;
    });
    expect(problems).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('overview-narrow.png'), fullPage: true });
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages and articles' })
      .click();
    await page.locator('.content-list li a').first().click();
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320
    );
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('.actions button, .actions a.button')]
          .filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width < 44 || box.height < 44 || node.scrollWidth > node.clientWidth + 1;
          })
          .map((node) => node.textContent?.trim())
      )
    ).toEqual([]);
    await page.screenshot({ path: test.info().outputPath('editor-narrow.png'), fullPage: true });
  });
});

test.describe('Dutch shell copy', () => {
  test.use({ locale: 'nl-NL', viewport: { width: 320, height: 900 } });
  test('keeps the active section and whole navigation labels at 200% text', async ({ page }) => {
    await login(page);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    await checkShell(page, 'Probe', 'Overzicht');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320
    );
    await page
      .getByRole('navigation', { name: 'Sitenavigatie' })
      .getByRole('link', { name: 'Pagina’s en artikelen' })
      .click();
    await checkShell(page, 'Probe', 'Pagina’s en artikelen');
  });
});
