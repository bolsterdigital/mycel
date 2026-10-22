import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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
  // The seed keeps the footer credit on (ADR 015 rule 5): a plain link, nothing else.
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Draait op Mycel' })
  ).toHaveAttribute('href', 'https://mycel.dev');
  await expectNoAxeViolations(page);
});

/** The console mailer spools each message as JSON (scripts/e2e.mjs sets MAIL_SPOOL_DIR). */
async function waitForMail(to: string): Promise<{ text: string }> {
  const dir = process.env['MAIL_SPOOL_DIR'];
  if (!dir) throw new Error('MAIL_SPOOL_DIR is not set; run through scripts/e2e.mjs');
  await expect
    .poll(
      () =>
        readdirSync(dir).some(
          (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to.email === to
        ),
      { timeout: 15_000, message: `confirmation mail to ${to}` }
    )
    .toBe(true);
  const file = readdirSync(dir).find(
    (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to.email === to
  )!;
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

/** `supporters.get` over the HTTP API (scripts/e2e.mjs starts it with a key for tenant probe). */
async function supporter(
  request: APIRequestContext,
  email: string
): Promise<{ lists: string[]; pendingLists: string[] } | null> {
  const res = await request.post(`${process.env['E2E_API_URL']}/v1/supporters.get`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data: { email },
  });
  if (res.status() === 404) return null;
  expect(res.ok()).toBe(true);
  return res.json();
}

test('signup with double opt-in: too-fast post, thank-you page, confirmation link, confirmed list', async ({
  page,
  request,
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

  // The worker ingests the signup (pending, ADR 010 rule 5) and sends the confirmation mail.
  const mail = await waitForMail(email);
  await expect
    .poll(() => supporter(request, email), { timeout: 15_000 })
    .toMatchObject({
      lists: [],
      pendingLists: ['newsletter'],
    });
  // The link is the site's canonical address (ADR 014 rule 6): its platform hostname
  // probe.localhost, which Chromium resolves to loopback, not the path form this spec posts from.
  const link = /https?:\/\/\S+\/confirm\?token=\S+/.exec(mail.text)![0];
  expect(link.startsWith('http://probe.localhost:4173/confirm?token=')).toBe(true);

  // Following the link confirms; a second visit says so without doing it again.
  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inschrijving bevestigd' })
  ).toBeVisible();
  await expectNoAxeViolations(page);
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'Al bevestigd' })).toBeVisible();
  await expectNoAxeViolations(page);

  await expect
    .poll(() => supporter(request, email), { timeout: 15_000 })
    .toMatchObject({
      lists: ['newsletter'],
      pendingLists: [],
    });
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
