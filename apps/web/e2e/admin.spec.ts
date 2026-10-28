// Operator admin (TODO #7), the seed of the "publish" flow in testing.md: login through the mock
// IdP as e2e-admin@probe.test (scripts/e2e.mjs seeds that admin and starts the IdP), access by
// membership, and an API key made in the admin that works over HTTP until it is revoked there.
// Runs without JavaScript and under axe like the signup spec. The UI gate (skill
// ui-action-layout) checks the members, domains and keys at 320 CSS px and at 200% text, in both
// locales: whole buttons, no broken word, 44 px targets, nothing past its card, and axe.

import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { ADMIN, login } from './lib/login';

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

const api = (path: string, token: string) =>
  fetch(`${process.env['E2E_API_URL']}${path}`, { headers: { authorization: `Bearer ${token}` } });

const formWith = (page: Page, heading: string) =>
  page.locator('form', { has: page.getByRole('heading', { level: 3, name: heading }) });

test('an admin logs in, makes an API key that works over HTTP, and revokes it', async ({
  page,
  context,
}) => {
  await login(page, '/admin/probe');
  await expect(page.getByRole('heading', { level: 1, name: 'Probe' })).toBeVisible();
  await expect(
    page.locator('.admin-sidebar-bottom').getByText('e2e-admin@probe.test')
  ).toBeVisible();
  await expect(
    page.locator('.admin-sidebar-bottom').getByRole('button', { name: 'Uitloggen' })
  ).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);
  await expectNoAxeViolations(page);

  const session = (await context.cookies()).find((c) => c.name === 'mycel_session');
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/admin' });
  const hours = (session!.expires * 1000 - Date.now()) / 3_600_000;
  expect(hours).toBeGreaterThan(11.9);
  expect(hours).toBeLessThanOrEqual(12);

  const name = `e2e-${test.info().project.name}-${Date.now()}`;
  const create = formWith(page, 'API-sleutel aanmaken');
  await create.getByLabel('Naam').fill(name);
  await create.getByLabel('content:read', { exact: true }).check();
  await create.getByRole('button', { name: 'Sleutel aanmaken' }).click();
  const token = (await page.locator('.token-value').textContent())?.trim() ?? '';
  expect(token).toMatch(/^mycel_[A-Za-z0-9_-]{43}$/);
  await expectNoAxeViolations(page);

  expect((await api('/v1/content.published.get?type=page&slug=signup', token)).status).toBe(200);
  // The key's own capabilities: reading content is not managing keys.
  expect((await api('/v1/tenant.key.list', token)).status).toBe(403);

  // Shown once: the next visit lists the key by its prefix only.
  await page.goto('/admin/probe');
  await expect(page.locator('.token-value')).toHaveCount(0);
  await expect(page.getByText(token.slice(0, 12))).toBeVisible();

  await formWith(page, name)
    .getByRole('button', { name: `Sleutel ${name} intrekken` })
    .click();
  await expect(page.getByRole('status')).toContainText('API-sleutel ingetrokken.');
  expect((await api('/v1/content.published.get?type=page&slug=signup', token)).status).toBe(401);
  await expectNoAxeViolations(page);

  // Logging out ends the session: the admin sends you back through the IdP.
  await page.getByRole('button', { name: 'Uitloggen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Je bent uitgelogd' })).toBeVisible();
  await expectNoAxeViolations(page);
  await page.goto('/admin/probe');
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
});

test('an operator without a membership sees no sites and gets 403 on one', async ({ page }) => {
  await login(page, '/admin', 'nobody@probe.test');
  await expect(page.getByRole('heading', { level: 1, name: 'Jouw sites' })).toBeVisible();
  await expect(page.getByText('Nog geen sites.')).toBeVisible();
  await expectNoAxeViolations(page);

  const response = await page.goto('/admin/probe');
  expect(response?.status()).toBe(403);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Geen toegang tot deze site' })
  ).toBeVisible();
  await expectNoAxeViolations(page);
});

test('the admin is not served on another origin', async ({ request }) => {
  const res = await request.get('/admin', { headers: { host: 'probe.example.org' } });
  expect(res.status()).toBe(404);
});

// TODO #20c decisions 1, 2 and 4: the admin's headers and CSP, the origin check on its form
// actions, and a fresh session cookie on every login. The Secure flag is in admin-paths.test.ts
// (this gate runs on http).
test('the admin sends its own headers and may not be framed at all', async ({ page, request }) => {
  const start = await request.get('/admin/login?return=/admin', { maxRedirects: 0 });
  expect(start.status()).toBe(303);
  expect(start.headers()['x-content-type-options']).toBe('nosniff');
  expect(start.headers()['referrer-policy']).toBe('same-origin');
  expect(start.headers()['permissions-policy']).toContain('camera=()');

  await login(page, '/admin/probe');
  const response = await page.goto('/admin/probe');
  const csp = response!.headers()['content-security-policy']!;
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toContain("frame-ancestors 'self'");
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(response!.headers()['referrer-policy']).toBe('same-origin');
});

test('an admin action posted from another origin is refused', async ({ request, baseURL }) => {
  const post = (origin: string) =>
    request.post('/admin/probe?/createKey', {
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      data: 'name=evil&capabilities=content%3Aread',
      maxRedirects: 0,
    });
  expect((await post('https://evil.example')).status()).toBe(403);
  // Same origin passes the check and meets the next boundary: no session, so not a 403 here.
  expect((await post(baseURL!)).status()).not.toBe(403);
});

test('every login issues a new session cookie and clears the attempt cookie', async ({
  page,
  context,
}) => {
  const session = async () =>
    (await context.cookies()).find((c) => c.name === 'mycel_session')?.value;
  await login(page, '/admin');
  const first = await session();
  expect(first).toBeTruthy();
  // A second login on the same browser, with the first session still present.
  await page.goto('/admin/login?return=/admin');
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(ADMIN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin$/);
  const second = await session();
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  expect((await context.cookies()).some((c) => c.name === 'mycel_oidc')).toBe(false);
  const cookie = (await context.cookies()).find((c) => c.name === 'mycel_session');
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/admin' });
});

for (const locale of ['nl-NL', 'en-US']) {
  test.describe(`UI gate ${locale}: members, domains and keys at 320 CSS px and 200% text`, () => {
    test.use({ viewport: NARROW, locale });

    for (const text of TEXT_SIZES) {
      test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
        test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
        await login(page, '/admin/probe');
        await setTextSize(page, text);
        await layoutGate(page, 'members, domains and keys', 'main');
        await expectNoAxeViolations(page);
      });
    }
  });
}
