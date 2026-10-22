import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
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

test.describe('an English visitor of a page published in Dutch only', () => {
  test.use({ locale: 'en-GB' });

  test('gets the Dutch publication and never the English draft', async ({ page, request }) => {
    const response = await page.goto('/probe/draft-check');
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    const html = await page.content();
    expect(html).toContain('Alleen Nederlands live');
    expect(html).not.toContain('EN-DRAFT');
    // The English path of an unpublished locale is a 404, never a fallback (TODO #8c2).
    const english = await request.get('/probe/en/draft-check');
    expect(english.status()).toBe(404);
    expect(await english.text()).not.toContain('EN-DRAFT');
  });
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
  // A Dutch browser on the English path: the path decides, not Accept-Language.
  test.use({ locale: 'nl-NL' });

  test('the English path serves English (the path is the locale, TODO #8c2)', async ({ page }) => {
    await page.goto('/probe/en/signup');
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

// TODO #20c: the response headers and the CSP of a public page, the nonce mode on a page that
// does ship SvelteKit's inline bootstrap (the root placeholder, the one route with `csr` on),
// and the origin check on the public form. Each would fail if the boundary were taken away.
const STRICT_CSP = [
  "default-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
];

/** Navigates to `path` and collects the CSP violations Chromium reports on the console. */
async function gotoWatchingCsp(page: Page, path: string): Promise<[Response, string[]]> {
  const seen: string[] = [];
  const listen = (msg: { text(): string }) => {
    if (/Content Security Policy/i.test(msg.text())) seen.push(msg.text());
  };
  page.on('console', listen);
  const response = await page.goto(path);
  await page.waitForLoadState('networkidle');
  page.off('console', listen);
  return [response!, seen];
}

test('a public page has the security headers and a strict CSP, and stays scriptless', async ({
  page,
}) => {
  const [response, violations] = await gotoWatchingCsp(page, '/probe/signup');
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toBe(
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  // Plain HTTP here (x-forwarded-proto), so no HSTS.
  expect(headers['strict-transport-security']).toBeUndefined();
  const csp = headers['content-security-policy']!;
  for (const directive of STRICT_CSP) expect(csp).toContain(directive);
  expect(csp).toMatch(/script-src 'self'(;|$)/);
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(await page.locator('script').count()).toBe(0);
  expect(await page.locator('[style]').count()).toBe(0);
  expect(violations).toEqual([]);
  await expectNoAxeViolations(page);
});

test('inline bootstrap runs on its per-response nonce, and only on that', async ({ page }) => {
  const nonceOf = (csp: string | undefined) => /'nonce-([^']+)'/.exec(csp ?? '')?.[1];
  const [first, violations] = await gotoWatchingCsp(page, '/');
  const nonce = nonceOf(first.headers()['content-security-policy']);
  expect(nonce).toBeTruthy();
  expect(first.headers()['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
  const inline = page.locator('script:not([src])');
  expect(await inline.count()).toBeGreaterThan(0);
  for (const script of await inline.all())
    expect(await script.evaluate((s) => (s as HTMLScriptElement).nonce)).toBe(nonce);
  // With JavaScript on (a11y project) the bootstrap actually executes under the policy.
  expect(violations).toEqual([]);

  const second = await page.request.get('/');
  const again = nonceOf(second.headers()['content-security-policy']);
  expect(again).toBeTruthy();
  expect(again).not.toBe(nonce);
});

test('a form post from another origin is refused, from its own origin it is not', async ({
  request,
  baseURL,
}) => {
  const post = (origin: string) =>
    request.post('/probe/signup', {
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      data: 'email=x%40example.org',
      maxRedirects: 0,
    });
  expect((await post('https://evil.example')).status()).toBe(403);
  expect((await post(baseURL!)).status()).not.toBe(403);
});
