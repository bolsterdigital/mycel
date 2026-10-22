// Hostnames (TODO #14, ADR 014): the site served from `Host` on its platform hostname
// probe.localhost (Chromium resolves *.localhost to loopback), a verified non-primary hostname
// redirecting to the primary, the admin never on a tenant hostname, Caddy's `allowed` question,
// and the admin's domain section without JavaScript and under axe. scripts/e2e.mjs runs both
// processes with SITE_URL_MODE=hostnames, so the confirmation mail links to probe.localhost; the
// development path form stays covered by signup.spec.ts.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SITE = 'http://probe.localhost:4173';

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
}

const formWith = (page: Page, heading: string) =>
  page.locator('form', { has: page.getByRole('heading', { level: 3, name: heading }) });

/** The console mailer spools each message as JSON (scripts/e2e.mjs sets MAIL_SPOOL_DIR). */
async function waitForMail(to: string): Promise<{ text: string }> {
  const dir = process.env['MAIL_SPOOL_DIR']!;
  const find = () =>
    readdirSync(dir).find((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to.email === to);
  await expect.poll(find, { timeout: 15_000, message: `confirmation mail to ${to}` }).toBeTruthy();
  return JSON.parse(readFileSync(join(dir, find()!), 'utf8'));
}

test('the site is served from Host on its platform hostname, and the mail links there', async ({
  page,
}) => {
  const response = await page.goto(`${SITE}/signup`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1, name: 'Blijf op de hoogte' })).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);
  await expectNoAxeViolations(page);

  const email = `e2e-host-${Date.now()}@example.org`;
  await page.waitForTimeout(3200);
  await page.getByLabel('E-mailadres').fill(email);
  await page.getByLabel(/nieuwsbrief ontvangen/).check();
  await page.getByRole('button', { name: 'Aanmelden' }).click();
  // The thank-you page stays on the hostname, without the slug in the path.
  await expect(page).toHaveURL(`${SITE}/signup/thanks`);
  await expect(page.getByRole('link', { name: 'Terug naar de pagina' })).toHaveAttribute(
    'href',
    '/signup'
  );

  const mail = await waitForMail(email);
  const link = /https?:\/\/\S+\/confirm\?token=\S+/.exec(mail.text)![0];
  expect(link.startsWith(`${SITE}/confirm?token=`)).toBe(true);
  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inschrijving bevestigd' })
  ).toBeVisible();
});

test('unknown hosts, the admin on a tenant hostname, and the allowed question', async ({
  request,
}) => {
  expect((await request.get(`${SITE}/admin`)).status()).toBe(404);
  expect((await request.get('/signup', { headers: { host: 'nope.example' } })).status()).toBe(404);
  // The path form only works on a development host.
  expect(
    (await request.get('/probe/signup', { headers: { host: 'probe.localhost' } })).status()
  ).toBe(404);
  // A verified, non-primary hostname (scripts/e2e.mjs seeds it) is a 301 to the primary, with
  // the path and query kept.
  const alias = await request.get('/signup?ref=x', {
    headers: { host: 'e2e-alias.example' },
    maxRedirects: 0,
  });
  expect(alias.status()).toBe(301);
  expect(alias.headers()['location']).toBe(`${SITE}/signup?ref=x`);
  const allowed = (domain: string) =>
    request.get(`/internal/hostnames/allowed?domain=${domain}`, {
      headers: { host: 'web.internal' },
    });
  expect((await allowed('probe.localhost')).status()).toBe(200);
  expect((await allowed('127.0.0.1')).status()).toBe(200);
  expect((await allowed('e2e-alias.example')).status()).toBe(200);
  expect((await allowed('nope.example')).status()).toBe(404);
  expect((await allowed('')).status()).toBe(404);
});

test('an admin adds a domain, sees the records, checks (not found), and cannot remove the primary', async ({
  page,
  request,
}) => {
  await login(page, 'e2e-admin@probe.test', '/admin/probe');
  const domain = `e2e-${test.info().project.name}-${Date.now()}.example`;
  const add = formWith(page, 'Domein toevoegen');
  await add.getByLabel('Hostnaam').fill(domain.toUpperCase());
  await add.getByRole('button', { name: 'Domein toevoegen' }).click();
  await expect(page.getByRole('status')).toContainText(`Domein ${domain} toegevoegd`);
  const card = formWith(page, domain);
  await expect(card.getByText(`_mycel-verify.${domain}`)).toBeVisible();
  await expect(card.locator('.dns-value')).toHaveText(/^[\w-]{43}$/);
  await expect(card.getByText('probe.localhost', { exact: true })).toBeVisible();
  await expect(card.getByText('nog niet geverifieerd')).toBeVisible();
  await expectNoAxeViolations(page);

  // An unverified hostname serves nothing and gets no certificate.
  expect((await request.get('/signup', { headers: { host: domain } })).status()).toBe(404);
  expect(
    (
      await request.get(`/internal/hostnames/allowed?domain=${domain}`, {
        headers: { host: 'web.internal' },
      })
    ).status()
  ).toBe(404);

  // The real resolver: a reserved TLD answers "not found" without an error page.
  await card.getByRole('button', { name: 'DNS controleren' }).click();
  await expect(page.getByRole('status')).toContainText('is nog niet gevonden');
  await expect(page.getByRole('status')).toContainText(`_mycel-verify.${domain}`);
  await expectNoAxeViolations(page);

  // Not verified: no "make primary" button; the platform hostname is primary and has none.
  await expect(formWith(page, domain).getByRole('button', { name: 'Primair maken' })).toHaveCount(
    0
  );
  await expect(formWith(page, 'probe.localhost').getByRole('button')).toHaveCount(0);

  // The same domain on another site is a conflict that names no owner.
  await add.getByLabel('Hostnaam').fill(domain);
  await add.getByRole('button', { name: 'Domein toevoegen' }).click();
  await expect(page.getByRole('alert')).toContainText('al in gebruik');
  await expect(page.getByRole('alert')).not.toContainText('probe');

  await formWith(page, domain).getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page.getByRole('status')).toContainText(`Domein ${domain} verwijderd`);
  await expect(formWith(page, domain)).toHaveCount(0);
  await expectNoAxeViolations(page);
});

test.describe('UI gate: the domain action group at 320 CSS px and 200% text', () => {
  test.use({ viewport: { width: 320, height: 900 } });

  for (const text of ['100%', '200%']) {
    test(`every button whole and no horizontal scroll, text ${text}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
      await login(page, 'e2e-admin@probe.test', '/admin/probe');
      const domain = `gate-${text.replace('%', '')}-${Date.now()}.example`;
      const add = formWith(page, 'Domein toevoegen');
      await add.getByLabel('Hostnaam').fill(domain);
      await add.getByRole('button', { name: 'Domein toevoegen' }).click();
      await expect(formWith(page, domain)).toBeVisible();
      if (text !== '100%') await page.addStyleTag({ content: `html { font-size: ${text}; }` });
      const problems = await page.evaluate(() => {
        const out: string[] = [];
        const width = document.documentElement.clientWidth;
        if (document.documentElement.scrollWidth > width) {
          out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
          // Name the culprits, so a failure says what to fix.
          for (const el of document.querySelectorAll('body *'))
            if (el.getBoundingClientRect().right > width + 1 && el.children.length === 0)
              out.push(
                `past the edge: <${el.tagName.toLowerCase()}> ${el.textContent?.trim().slice(0, 40)}`
              );
        }
        for (const b of document.querySelectorAll('button')) {
          const r = b.getBoundingClientRect();
          const label = b.textContent?.trim() ?? '';
          if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${label}`);
          if (r.right > width + 1 || r.left < -1) out.push(`outside the viewport: ${label}`);
          if (r.height < 44 || r.width < 44) out.push(`tap target under 44px: ${label}`);
        }
        return out;
      });
      await formWith(page, domain).screenshot({
        path: test.info().outputPath(`domains-320-${text.replace('%', '')}.png`),
      });
      expect(problems).toEqual([]);
      await formWith(page, domain).getByRole('button', { name: 'Verwijderen' }).click();
      await expect(formWith(page, domain)).toHaveCount(0);
    });
  }
});
