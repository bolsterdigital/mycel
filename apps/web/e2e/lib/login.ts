// Sign in through the mock IdP (scripts/e2e/mock-oidc.mjs), the one way every admin spec gets a
// session. Each login comes from an address of its own: the admin allows twenty logins per
// address in ten minutes, and a file that logs in per test passes that within one worker. The
// addresses are IPv6 documentation space, so they never count against the IPv4 addresses the
// public specs draw for their own rate limits.
// Rejected: one shared address per file in `test.use` (eleven specs each had their own copy of
// this function, five of them without a fresh address, and the limit fell on whichever ran last).

import { expect, type Page } from '@playwright/test';

/** The admin `scripts/e2e/e2e.mjs` seeds as `tenant:admin` of the probe site. */
export const ADMIN = 'e2e-admin@probe.test';

/** An IPv6 documentation address no other request of the run is likely to use. */
export const freshAddress = () =>
  `2001:db8::${Math.floor(Math.random() * 0xffffffff).toString(16)}`;

/** The headers the server under test reads behind Caddy, with a fresh client address. */
export const forwarded = (address = freshAddress()) => ({
  'x-forwarded-proto': 'http',
  'x-forwarded-for': address,
});

const escape = (path: string) => path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * Go to `path`, land on the admin's login page, press its button, get sent through the mock IdP's
 * sign-in form as `email`, and land back on `path`.
 * `headers` are kept on the context next to the fresh address (an `accept-language`, say).
 */
export async function login(
  page: Page,
  path: string,
  email = ADMIN,
  headers: Record<string, string> = {}
) {
  await page.context().setExtraHTTPHeaders({ ...headers, ...forwarded() });
  await page.goto(path);
  await page.locator('main a[href*="start=1"]').click();
  await expect(
    page.getByRole('heading', { name: 'Mock IdP' }),
    `login route: ${path}`
  ).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${escape(path)}$`));
}
