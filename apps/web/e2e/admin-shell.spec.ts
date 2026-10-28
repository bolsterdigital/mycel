// The tenant shell is one navigation surface across routes, locales and site memberships.
// A second, empty site catches stale site names and links when changing tenants.
import { Invoker, UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import { upsertTenant } from '@mycel/db';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';

const email = 'shell-admin@probe.test';
const other = 'shell-other';
// A live API key whose name has no break opportunity: its revoke button repeats the name. While
// admin.spec.ts holds such a key (`e2e-a11y-<timestamp>`), the overview ran past 320 CSS px at
// 200% text on CI's wider Linux fallback font, intermittently (TODO #27). This name is long
// enough to overflow with any font, so the check holds on every run and platform.
const SHELL = '.admin-sidebar, .admin-menu';
const unbroken = 'newsletter_sync_production_e2e_a11y_1761600000000';

/** Runs one use case as the system on tenant probe, outside the browser. */
async function onProbe<T>(run: (invoker: Invoker, tenantId: string) => Promise<T>): Promise<T> {
  const probe = await tenantId();
  return withInvoker((invoker) => run(invoker, probe));
}

test.beforeAll(async () => {
  const probe = await tenantId();
  const tenant = await asOwner((owner) =>
    upsertTenant(
      owner,
      {
        id: crypto.randomUUID(),
        slug: other,
        name: 'Second editorial site',
        defaultLocale: 'en',
        locales: ['en', 'nl'],
      },
      { platformDomain: process.env['PLATFORM_DOMAIN']! }
    )
  );
  await withInvoker(async (invoker) => {
    for (const site of [probe, tenant.id]) {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(site, 'e2e'), {
          email,
          capabilities: ['tenant:admin'],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    }
  });
});

async function checkShell(page: Page, name: string, current: string) {
  await expect(page.locator('.admin-site-name')).toHaveText(name);
  await expect(
    page
      .getByRole('navigation', { name: /sitenavigatie|site navigation/i })
      .getByRole('link', { name: current })
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('main')).toHaveCount(1);
  if (test.info().project.name === 'a11y') await expectNoAxeViolations(page);
  else {
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
  await login(page, '/admin/probe', email);
  await checkShell(page, 'Probe', 'Overview');
  await page
    .getByRole('navigation', { name: 'Site navigation' })
    .getByRole('link', { name: 'Pages and articles' })
    .click();
  await checkShell(page, 'Probe', 'Pages and articles');
  await expect(page.locator('#content-table tbody tr').first()).toBeVisible();
  await page.locator('#content-table tbody th a').first().click();
  await checkShell(page, 'Probe', 'Pages and articles');
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
  await expect(page.locator('#content-table tbody tr')).toHaveCount(0);
  await checkShell(page, 'Second editorial site', 'Pages and articles');
  await expect(page.locator('body')).not.toContainText('Probe');
});

test.describe('narrow navigation and action labels', () => {
  test.use({ viewport: NARROW });
  test('works with keyboard and at 200% text', async ({ page }) => {
    const { id } = await onProbe((invoker, tenantId) =>
      invoker.run(useCases.createKey, systemPrincipal(tenantId, 'e2e'), {
        name: `${unbroken}_${test.info().project.name}`,
        capabilities: ['content:read'],
      })
    );
    try {
      await narrowOverview(page);
    } finally {
      await onProbe((invoker, tenantId) =>
        invoker.run(useCases.revokeKey, systemPrincipal(tenantId, 'e2e'), { id })
      );
    }
  });
});

/** The overview and an editor at 320 CSS px and 200% text: reflow, targets and whole labels. */
async function narrowOverview(page: Page) {
  await login(page, '/admin/probe', email);
  await setTextSize(page, '200%');
  const menu = page.getByText('Menu', { exact: true });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
  await page.keyboard.press('Enter');
  await expect(page.locator('.admin-menu')).toHaveAttribute('open');
  // The shell's own controls; the overview's content has its gate in admin.spec.ts.
  await layoutGate(page, 'overview with the menu open', SHELL);
  await page
    .getByRole('navigation', { name: 'Site navigation' })
    .getByRole('link', { name: 'Pages and articles' })
    .click();
  await page.locator('#content-table tbody th a').first().click();
  await setTextSize(page, '200%');
  await layoutGate(page, 'editor');
}

test.describe('Dutch shell copy', () => {
  test.use({ locale: 'nl-NL', viewport: NARROW });
  test('keeps the active section and whole navigation labels at 200% text', async ({ page }) => {
    await login(page, '/admin/probe', email);
    await setTextSize(page, '200%');
    await checkShell(page, 'Probe', 'Overzicht');
    await layoutGate(page, 'overview', SHELL);
    await page
      .getByRole('navigation', { name: 'Sitenavigatie' })
      .getByRole('link', { name: 'Pagina’s en artikelen' })
      .click();
    await checkShell(page, 'Probe', 'Pagina’s en artikelen');
  });
});
