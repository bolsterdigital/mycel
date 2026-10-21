import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

// Playwright derives Accept-Language from `locale`; the random client address gives each run a
// fresh per-IP rate-limit bucket (see ADDRESS_HEADER in playwright.config.ts).
test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

test('signup page renders from blocks without JavaScript and passes axe', async ({ page }) => {
  const response = await page.goto('/probe/signup');
  expect(response?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.getByRole('heading', { level: 1, name: 'Blijf op de hoogte' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Meld je aan voor de nieuwsbrief' })
  ).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);
  await expectNoAxeViolations(page);
});

test('a too-fast post shows an accessible error, a later one reaches the thank-you page', async ({
  page,
}) => {
  const email = `e2e-${Date.now()}@example.org`;
  await page.goto('/probe/signup');
  await page.getByLabel('E-mailadres').fill(email);
  await page.getByLabel(/nieuwsbrief ontvangen/).check();
  await page.getByRole('button', { name: 'Aanmelden' }).click();

  await expect(page).toHaveTitle(/^Fout: /);
  await expect(page.getByRole('alert')).toContainText('Dat ging erg snel');
  await expect(page.getByLabel('E-mailadres')).toHaveValue(email);
  await expectNoAxeViolations(page);

  // The re-rendered form carries a fresh timing token; wait past the minimum fill time.
  await page.waitForTimeout(3200);
  await page.getByLabel(/nieuwsbrief ontvangen/).check();
  await page.getByRole('button', { name: 'Aanmelden' }).click();

  await expect(page).toHaveURL(/\/probe\/signup\/thanks$/);
  await expect(page.getByText('Bedankt! Check je mailbox')).toBeVisible();
  await expectNoAxeViolations(page);
});

test.describe('in English', () => {
  test.use({ locale: 'en-GB' });

  test('the page negotiates English from Accept-Language', async ({ page }) => {
    await page.goto('/probe/signup');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'Stay informed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test('an invalid confirmation link explains itself and passes axe', async ({ page }) => {
  await page.goto('/probe/confirm?token=forged');
  await expect(page.getByRole('heading', { level: 1, name: 'Deze link werkt niet' })).toBeVisible();
  await expectNoAxeViolations(page);
});
