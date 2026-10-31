// flow: access
// Hostnames (TODO #14, ADR 014): the site served from `Host` on its platform hostname
// probe.localhost (Chromium resolves *.localhost to loopback), a verified non-primary hostname
// redirecting to the primary, the admin never on a tenant hostname, Caddy's `allowed` question,
// and the admin's domain section without JavaScript and under axe. scripts/e2e/e2e.mjs runs both
// processes with SITE_URL_MODE=hostnames, so the confirmation mail links to probe.localhost; the
// development path form stays covered by signup.spec.ts.

import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { expectNoAxeViolations } from './lib/axe';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { pastMinimumFillTime } from './lib/form';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { systemPrincipal } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';

const SITE = 'http://probe.localhost:4173';

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

const formWith = (page: Page, heading: string) =>
  page.locator('form', {
    has: page.getByRole('heading', { level: 3, name: heading, exact: true }),
  });

/**
 * Adds a domain through the dialog the "Domein toevoegen" invoker button opens (no script): a
 * separate subdomain unless `main` says it is the organisation's own domain (#115).
 */
async function addDomain(page: Page, hostname: string, kind: 'main' | 'sub' = 'sub') {
  await page.getByRole('button', { name: 'Domein toevoegen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Domein toevoegen' });
  await dialog.getByLabel('Hostnaam').fill(hostname);
  await dialog
    .getByLabel(kind === 'main' ? /eigen domein van je organisatie/ : /los subdomein/)
    .check();
  await dialog.getByRole('button', { name: 'Domein toevoegen' }).click();
}

/** Removing asks first, in the domain's own row: the summary opens, the second button posts. */
async function removeDomain(page: Page, hostname: string) {
  const row = formWith(page, hostname);
  await expect(row.getByRole('button', { name: `Ja, verwijderen: ${hostname}` })).toBeHidden();
  await row.locator('summary', { hasText: 'Verwijderen' }).click();
  await row.getByRole('button', { name: `Ja, verwijderen: ${hostname}` }).click();
}

/** The console mailer spools each message as JSON (scripts/e2e/e2e.mjs sets MAIL_SPOOL_DIR). */
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
  // Only the form's own proof-of-work module (brief form-intake § D2.3).
  expect(await page.locator('script:not([src="/_form/proof.js"])').count()).toBe(0);
  await expectNoAxeViolations(page);

  const email = `e2e-host-${Date.now()}@example.org`;
  await pastMinimumFillTime(page);
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
  // The button posts on the hostname and the outcome stays there, without the slug or the token.
  await page.goto(link);
  await page.getByRole('button', { name: 'Bevestig mijn inschrijving' }).click();
  await expect(page).toHaveURL(`${SITE}/confirm/confirmed?locale=nl`);
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
  // A verified, non-primary hostname (scripts/e2e/e2e.mjs seeds it) is a 301 to the primary, with
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

// TODO #20c decision 5: without MYCEL_TRUST_PROXY (the e2e server sets no HOST_HEADER) a
// forwarded host is just a header. It neither picks another site nor reaches the admin.
test('X-Forwarded-Host does not choose the site or open the admin', async ({ request }) => {
  const viaPlatform = await request.get('/signup', {
    headers: { 'x-forwarded-host': 'probe.localhost:4173' },
  });
  expect(viaPlatform.status()).toBe(404);
  expect(await viaPlatform.text()).not.toContain('Blijf op de hoogte');

  const adminFromTenant = await request.get(`${SITE}/admin`, {
    headers: { 'x-forwarded-host': '127.0.0.1:4173' },
    maxRedirects: 0,
  });
  expect(adminFromTenant.status()).toBe(404);
});

// The main e2e server deliberately trusts X-Forwarded-Proto to model HTTP behind Caddy.
// A second adapter-node process proves the untrusted boundary instead of relying on that fixture.
test('without proxy configuration, forwarded protocol and host cannot change the admin origin', async () => {
  const port = isA11y() ? 4174 : 4175;
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  for (const key of [
    'DATABASE_URL',
    'PROTOCOL_HEADER',
    'HOST_HEADER',
    'ADDRESS_HEADER',
    'XFF_DEPTH',
  ])
    delete env[key];
  const server = spawn(process.execPath, ['build/index.js'], {
    env: {
      ...env,
      HOST: '127.0.0.1',
      PORT: String(port),
      MYCEL_TRUST_PROXY: '0',
      // adapter-node defaults to https without PROTOCOL_HEADER, even on a plain HTTP socket.
      PUBLIC_BASE_URL: origin.replace('http:', 'https:'),
    },
    stdio: 'ignore',
  });
  const closed = once(server, 'close');
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`${origin}/healthz`)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 15_000 }
      )
      .toBe(200);
    for (const headers of [
      {} as Record<string, string>,
      { 'x-forwarded-proto': 'http', 'x-forwarded-host': 'evil.example' },
    ]) {
      const response = await fetch(`${origin}/admin`, { headers, redirect: 'manual' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toContain('/admin/login');
      expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    }
  } finally {
    server.kill('SIGTERM');
    await closed;
  }
});

test('an admin adds a domain, sees the records, checks (not found), and cannot remove the primary', async ({
  page,
  request,
}) => {
  await login(page, '/admin/probe/domeinen');
  const domain = `e2e-${test.info().project.name}-${Date.now()}.example`;
  await addDomain(page, domain.toUpperCase());
  await expect(page.getByRole('status')).toContainText(`Domein ${domain} toegevoegd`);
  const card = formWith(page, domain);
  await expect(card.getByText(`_mycel-verify.${domain}`)).toBeVisible();
  await expect(card.locator('code[id$="-txt-value"]')).toHaveText(/^[\w-]{43}$/);
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
  await addDomain(page, domain);
  await expect(page.getByRole('alert')).toContainText('al in gebruik');
  await expect(page.getByRole('alert')).not.toContainText('probe');

  await removeDomain(page, domain);
  await expect(page.getByRole('status')).toContainText(`Domein ${domain} verwijderd`);
  await expect(formWith(page, domain)).toHaveCount(0);
  await expectNoAxeViolations(page);
});

// #115: an organisation's own domain is added as its bare and its www name and shown as one
// card with the records per name; a separate subdomain is one name without a word about www.
test('a main domain is added as both of its names, a subdomain as one', async ({
  page,
  request,
}) => {
  await login(page, '/admin/probe/domeinen');
  const domain = `pair-${test.info().project.name}-${Date.now()}.example`;
  // Typed with www: the bare name is the card, both names are added.
  await addDomain(page, `www.${domain}`, 'main');
  await expect(page.getByRole('status')).toContainText(
    `Domeinen ${domain} en www.${domain} toegevoegd`
  );
  const pair = formWith(page, domain);
  for (const name of [domain, `www.${domain}`]) {
    await expect(pair.getByRole('heading', { level: 4, name, exact: true })).toBeVisible();
    await expect(pair.getByText(`_mycel-verify.${name}`, { exact: true })).toBeVisible();
    // Neither is verified, so neither serves or gets a certificate yet.
    const allowed = await request.get(`/internal/hostnames/allowed?domain=${name}`, {
      headers: { host: 'web.internal' },
    });
    expect(allowed.status()).toBe(404);
  }
  // The bare name points with an ALIAS (it cannot take a CNAME), www with a CNAME.
  await expect(pair).toContainText('ALIAS- of ANAME-record');
  await expect(pair).toContainText('CNAME-record');
  await expect(pair).toContainText('Zodra beide geverifieerd zijn');
  await expect(pair.getByRole('button', { name: /als adres gebruiken/i })).toHaveCount(0);
  await expectNoAxeViolations(page);

  // A separate subdomain: one name, a CNAME, nothing about www or a bare domain.
  const sub = `campagne.${domain}`;
  await addDomain(page, sub);
  await expect(page.getByRole('status')).toContainText(`Domein ${sub} toegevoegd`);
  const single = formWith(page, sub);
  await expect(single).toContainText('CNAME-record');
  await expect(single).not.toContainText('www');
  await expect(single).not.toContainText('ALIAS');

  // Both names or neither: when www is taken, the bare name added a moment before goes again.
  const taken = `taken-${domain}`;
  await addDomain(page, `www.${taken}`);
  await addDomain(page, taken, 'main');
  await expect(page.getByRole('alert')).toContainText('al in gebruik');
  await expect(formWith(page, taken)).toHaveCount(0);

  // Removing the main domain removes both names.
  await pair.locator('summary', { hasText: 'Verwijderen' }).click();
  await pair.getByRole('button', { name: `Ja, verwijderen: ${domain}` }).click();
  await expect(page.getByRole('status')).toContainText('verwijderd');
  await expect(page.getByRole('heading', { name: `www.${domain}`, exact: true })).toHaveCount(0);
  await expect(formWith(page, domain)).toHaveCount(0);
  for (const name of [sub, `www.${taken}`]) await removeDomain(page, name);
});

// #115 scenarios 1a and 1b: once both names are verified, the one the operator makes primary is
// the address and the other answers with a 301 to it; both get a certificate. Fixtures on a site
// of their own, so the primary of probe stays as every other test expects.
for (const address of ['bare', 'www'] as const)
  test(`a verified main domain with ${address} as the address redirects the other name`, async ({
    request,
  }) => {
    const slug = `pair-${address}-${test.info().project.name}-${Date.now()}`;
    const tenant = await asOwner((owner) =>
      testTenant(owner, slug, { platformDomain: process.env['PLATFORM_DOMAIN']! })
    );
    const apex = `${slug}.example`;
    const www = `www.${apex}`;
    const [primary, other] = address === 'bare' ? [apex, www] : [www, apex];
    await withInvoker((_invoker, uow) =>
      uow.run(systemPrincipal(tenant.id, 'e2e'), async (ctx) => {
        for (const hostname of [apex, www]) {
          await ctx.hostnames.insert({
            hostname,
            kind: 'custom',
            verificationToken: 'e2e-fixture',
            verifiedAt: null,
            createdAt: new Date(),
          });
          await ctx.hostnames.setVerified(hostname, new Date());
        }
        await ctx.hostnames.setPrimary(primary);
      })
    );
    const redirect = await request.get('/nieuws?p=2', {
      headers: { host: other },
      maxRedirects: 0,
    });
    expect(redirect.status()).toBe(301);
    expect(redirect.headers()['location']).toBe(`http://${primary}:4173/nieuws?p=2`);
    for (const name of [apex, www]) {
      const allowed = await request.get(`/internal/hostnames/allowed?domain=${name}`, {
        headers: { host: 'web.internal' },
      });
      expect(allowed.status()).toBe(200);
    }
  });

test.describe('UI gate: the domain action group at 320 CSS px and 200% text', () => {
  test.use({ viewport: NARROW });

  for (const text of TEXT_SIZES) {
    test(`every button whole and no horizontal scroll, text ${text}`, async ({ page }) => {
      onlyA11y('measures the layout with a script');
      await login(page, '/admin/probe/domeinen');
      // A main domain whose two names are verified: the card with the most actions, "check
      // both", "use as the address" under each long name, and remove (#115).
      const domain = `gate-${text.replace('%', '')}-${Date.now()}-a-longer-name.example`;
      await addDomain(page, domain, 'main');
      await expect(formWith(page, domain)).toBeVisible();
      const probe = await tenantId();
      await withInvoker((_invoker, uow) =>
        uow.run(systemPrincipal(probe, 'e2e'), async (ctx) => {
          for (const name of [domain, `www.${domain}`])
            await ctx.hostnames.setVerified(name, new Date());
        })
      );
      await page.reload();
      await expect(
        formWith(page, domain).getByRole('button', { name: /als adres gebruiken/i })
      ).toHaveCount(2);
      await setTextSize(page, text);
      await formWith(page, domain).locator('summary', { hasText: 'Verwijderen' }).click();
      await layoutGate(page, 'domain actions');
      await formWith(page, domain)
        .getByRole('button', { name: `Ja, verwijderen: ${domain}` })
        .click();
      await expect(formWith(page, domain)).toHaveCount(0);
    });
  }
});
