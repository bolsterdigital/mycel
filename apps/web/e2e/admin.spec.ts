// flow: access
// Who may administer a site, and what the admin shows them: sign-in, membership, API keys, the
// status page, managed connections, the site's hostnames and the export of its data. Each part
// below was a spec of its own until TODO #50 and #171 folded the suite to its budget (testing.md §
// End-to-end flows); each keeps its own fixtures in its own describe.

import { openPublication } from './lib/publication';
import {
  SYNTHETIC_SCOPE,
  capabilitiesFor,
  SYNTHETIC_SOURCE,
  UseCaseError,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { createServer } from 'node:http';
import { type AddressInfo } from 'node:net';
import { FakeDns } from '@mycel/core/testing';
import { type Database, uuidv7Ids } from '@mycel/db';
import { asRole, testTenant } from '@mycel/db/testing';
import { type Page, expect, test } from '@playwright/test';
import { type Kysely } from 'kysely';
import { expectNoAxeViolations } from './lib/axe';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { ADMIN, login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { settingsEvidence } from './lib/settings-evidence';
import { callApi, requireApi } from './lib/api';
import { randomUUID } from 'node:crypto';
import { ADMIN_ROUTES } from './routes';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { pastMinimumFillTime } from './lib/form';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';

// A worker-scoped option on a separate test type keeps timeout-safe tracing on this flow only.
const settingsTest = test.extend({ trace: ['retain-on-failure', { scope: 'worker' }] });

// Operator admin (TODO #7), the seed of the "publish" flow in testing.md: login through the mock
// IdP as e2e-admin@probe.test (scripts/e2e/e2e.mjs seeds that admin and starts the IdP), access by
// membership, and an API key made in the admin that works over HTTP until it is revoked there.
// Runs without JavaScript and under axe like the signup spec. The dashboard and the members and
// domains pages (moved verbatim from the tenant home in #66 PR 1) are routes of the generic UI
// gate (routes.ts).
test.describe('admin', () => {
  test.use({
    locale: 'nl-NL',
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
  });

  const api = (path: string, token: string) =>
    fetch(`${requireApi()}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  const formWith = (page: Page, heading: string) =>
    page.locator('form', { has: page.getByRole('heading', { level: 3, name: heading }) });

  test('an admin logs in, makes an API key that works over HTTP, and revokes it', async ({
    page,
    context,
  }) => {
    await login(page, '/admin/probe/leden');
    await expect(page.getByRole('heading', { level: 1, name: 'Team' })).toBeVisible();
    await page.locator('.admin-account > summary').click();
    await expect(
      page.locator('.admin-account-actions').getByText('e2e-admin@probe.test')
    ).toBeVisible();
    await expect(
      page.locator('.admin-account-actions').getByRole('button', { name: 'Uitloggen' })
    ).toBeVisible();
    // The shell's one script is the menu's collapse button (#87); the screen itself has none.
    expect(await page.locator('script:not([src="/_admin/nav.js"])').count()).toBe(0);
    await expectNoAxeViolations(page);

    const session = (await context.cookies()).find((c) => c.name === 'mycel_session');
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/admin' });
    const hours = (session!.expires * 1000 - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);

    const name = `e2e-${test.info().project.name}-${Date.now()}`;
    // Keys live under API access (#101), one of the screens of Beheer since #114, no longer a
    // sentence on Team (#113).
    await expect(page.locator('main a[href$="section=api"]')).toHaveCount(0);
    await page.getByRole('link', { name: 'Beheer', exact: true }).click();
    await page.getByRole('main').getByRole('link', { name: 'API-toegang' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/site\?section=api$/);
    // Creating a key happens in a dialog, opened by a native invoker button (no script), with
    // the role picker without Administrator.
    await page.getByRole('button', { name: 'API-sleutel aanmaken' }).click();
    const create = page.getByRole('dialog', { name: 'API-sleutel aanmaken' });
    await create.getByLabel('Naam').fill(name);
    await expect(create.getByRole('radio', { name: /^Beheerder/ })).toHaveCount(0);
    await create.getByRole('radio', { name: /^Auteur/ }).check();
    await create.getByRole('button', { name: 'Sleutel aanmaken' }).click();
    const token = (await page.locator('#new-key-value').textContent())?.trim() ?? '';
    expect(token).toMatch(/^mycel_[A-Za-z0-9_-]{43}$/);
    await expectNoAxeViolations(page);

    expect((await api('/v1/content.published.get?type=page&slug=signup', token)).status).toBe(200);
    // The key's own capabilities: reading content is not managing keys.
    expect((await api('/v1/tenant.key.list', token)).status).toBe(403);

    // Shown once: the next visit lists the key by its prefix only, with its role.
    await page.goto('/admin/probe/site?section=api');
    await expect(page.locator('#new-key-value')).toHaveCount(0);
    await expect(page.getByText(token.slice(0, 12))).toBeVisible();
    await expect(formWith(page, name)).toContainText('Auteur');

    // Revoking asks first, in the key's own row: the summary opens, the second button posts.
    const row = formWith(page, name);
    await expect(row.getByRole('button', { name: `Ja, intrekken: ${name}` })).toBeHidden();
    await row.locator('summary', { hasText: 'Sleutel intrekken' }).click();
    await row.getByRole('button', { name: `Ja, intrekken: ${name}` }).click();
    await expect(page.getByRole('status')).toContainText('API-sleutel ingetrokken.');
    expect((await api('/v1/content.published.get?type=page&slug=signup', token)).status).toBe(401);
    await expectNoAxeViolations(page);

    // Logging out ends the session: the admin sends you to the login page, which says why and
    // returns you to the page you asked for.
    await page.locator('.admin-account > summary').click();
    await page.getByRole('button', { name: 'Uitloggen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Je bent uitgelogd' })).toBeVisible();
    await expectNoAxeViolations(page);
    await page.goto('/admin/probe');
    await expect(page.getByRole('heading', { level: 1, name: 'Inloggen' })).toBeVisible();
    await expect(page.locator('main')).toContainText('of je sessie is verlopen');
    await expect(page.getByRole('link', { name: 'Inloggen' })).toHaveAttribute(
      'href',
      '/admin/login?return=%2Fadmin%2Fprobe&start=1'
    );
  });

  // Roles as presets over capabilities (#101): invite as Editor, then make the set Custom in the
  // advanced part; the stored set is what the role says, and the table names the role.
  test('an admin invites an editor by role and makes them custom', async ({ page }) => {
    const email = `role-${test.info().project.name}-${Date.now()}@probe.test`;
    const probe = await tenantId();
    const member = async () =>
      (
        await withInvoker((invoker) =>
          invoker.run(useCases.listMembers, systemPrincipal(probe, 'e2e'), {})
        )
      ).members.find((m) => m.email === email);
    await login(page, '/admin/probe/leden');
    // Your own row says so and cannot remove itself.
    const own = page.getByRole('row', { name: new RegExp(ADMIN) });
    await expect(own).toContainText('(jij)');
    await expect(own).toContainText('Beheerder');
    await expect(own.getByText('Verwijderen')).toHaveCount(0);
    try {
      await page.getByRole('button', { name: 'Iemand uitnodigen' }).click();
      const invite = page.getByRole('dialog', { name: 'Iemand uitnodigen' });
      await invite.getByLabel('E-mailadres').fill(email);
      await invite.getByRole('radio', { name: /^Redacteur/ }).check();
      await invite.getByRole('button', { name: 'Uitnodigen' }).click();
      await expect(page.getByRole('status')).toContainText(`${email} is uitgenodigd.`);
      const row = page.getByRole('row', { name: new RegExp(email) });
      await expect(row).toContainText('Redacteur');
      expect((await member())?.capabilities.sort()).toEqual(capabilitiesFor('editor').sort());
      expect((await member())?.role).toBe('editor');
      await expectNoAxeViolations(page);

      await row.getByRole('button', { name: 'Rol wijzigen' }).click();
      const change = page.getByRole('dialog', { name: `Rol van ${email}` });
      await expect(change.getByRole('radio', { name: /^Redacteur/ })).toBeChecked();
      await change.getByRole('radio', { name: /^Aangepast/ }).check();
      await change.locator('summary', { hasText: 'Geavanceerd' }).click();
      await change.getByLabel('forms:read', { exact: true }).uncheck();
      await change.getByRole('button', { name: 'Opslaan' }).click();
      await expect(page.getByRole('status')).toContainText('Rol opgeslagen.');
      await expect(page.getByRole('row', { name: new RegExp(email) })).toContainText('Aangepast');
      expect((await member())?.role).toBe('custom');
      expect((await member())?.capabilities).not.toContain('forms:read');
      await expectNoAxeViolations(page);
    } finally {
      const found = await member();
      if (found)
        await withInvoker((invoker) =>
          invoker.run(useCases.removeMember, systemPrincipal(probe, 'e2e'), {
            operatorId: found.operatorId,
          })
        );
    }
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

  // A refusal by the use case in a page load is the 403 page, not a server error; the
  // route asks nothing itself. An editor lacks `tenant:admin` (log, status, export, members) and
  // `connections:read`.
  test('a member without the capability gets "no access" on an admin page', async ({ page }) => {
    const email = `editor-${test.info().project.name}-${Date.now()}@probe.test`;
    const probe = await tenantId();
    const system = systemPrincipal(probe, 'e2e');
    const member = await withInvoker((invoker) =>
      invoker.run(useCases.inviteMember, system, {
        email,
        capabilities: capabilitiesFor('editor'),
      })
    );
    try {
      await login(page, '/admin/probe/content?type=page', email);
      for (const path of ['status/audit', 'status', 'export', 'leden', 'connections']) {
        const response = await page.goto(`/admin/probe/${path}`);
        expect(response?.status(), path).toBe(403);
        await expect(
          page.getByRole('heading', { level: 1, name: 'Geen toegang tot deze pagina' }),
          path
        ).toBeVisible();
        await expect(page.locator('main')).toContainText('Je rol op deze site');
      }
      await expectNoAxeViolations(page);
      // A cursor edited by hand is invalid input for `audit.list`: a 400 in words, for an admin.
      await page.context().clearCookies();
      await login(page, '/admin/probe/status');
      const response = await page.goto('/admin/probe/status/audit?cursor=not-a-cursor');
      expect(response?.status()).toBe(400);
      await expect(page.locator('main')).toContainText('waarde die niet te gebruiken is');
    } finally {
      await withInvoker((invoker) =>
        invoker.run(useCases.removeMember, system, { operatorId: member.operatorId })
      );
    }
  });

  // #51: a route's refusal is a code, the page says it in the operator's language; the preview
  // routes have no admin layout of their own and show the same page.
  for (const [language, header, notFound, noAccess] of [
    ['nl', 'nl-NL', 'Pagina niet gevonden', 'Geen toegang tot deze pagina'],
    ['en', 'en-GB', 'Page not found', 'No access to this page'],
  ] as const)
    test.describe(`in ${language}`, () => {
      test.use({ locale: header });

      test('a refusal reads the same on the admin and on its preview', async ({ page }) => {
        await login(page, '/admin/probe/status');
        for (const path of ['content/not-an-id', 'preview/item/not-an-id']) {
          expect((await page.goto(`/admin/probe/${path}`))?.status(), path).toBe(404);
          await expect(page.getByRole('heading', { level: 1, name: notFound }), path).toBeVisible();
          await expect(page.locator('html'), path).toHaveAttribute('lang', language);
          await expect(page.locator('main'), path).not.toContainText('not_found');
        }
        await expectNoAxeViolations(page);
        const email = `refusal-${language}-${test.info().project.name}-${Date.now()}@probe.test`;
        const system = systemPrincipal(await tenantId(), 'e2e');
        const member = await withInvoker((invoker) =>
          invoker.run(useCases.inviteMember, system, {
            email,
            capabilities: capabilitiesFor('editor'),
          })
        );
        try {
          await page.context().clearCookies();
          await login(page, '/admin/probe/content?type=page', email);
          // A check written in the route itself, not a refusal by a use case.
          expect((await page.goto('/admin/probe/site?section=assist'))?.status()).toBe(403);
          await expect(page.getByRole('heading', { level: 1, name: noAccess })).toBeVisible();
        } finally {
          await withInvoker((invoker) =>
            invoker.run(useCases.removeMember, system, { operatorId: member.operatorId })
          );
        }
      });
    });

  // #140: a save on a block type the site no longer has says which type, in the words of the screen.
  test('a save refused on a switched-off block type names that type', async ({ page }) => {
    const project = test.info().project.name;
    const slug = `block-off-${project}`;
    const email = `block-off-${project}@probe.test`;
    const tenant = await asOwner((owner) =>
      testTenant(owner, slug, {
        name: 'Switched-off block',
        locales: ['nl'],
        platformDomain: process.env['PLATFORM_DOMAIN']!,
        reuse: true,
      })
    );
    const blocks = (off: Record<string, boolean>) =>
      asOwner((owner) =>
        owner
          .updateTable('tenants')
          .set({ entitlements: JSON.stringify({ blocks: off }) })
          .where('id', '=', tenant.id)
          .execute()
      );
    const uiLocale = (value: 'en' | null) =>
      asOwner((owner) =>
        owner
          .updateTable('operators')
          .set({ ui_locale: value })
          .where('email', '=', email)
          .execute()
      );
    await blocks({});
    const itemId = await withInvoker(async (invoker) => {
      const admin = systemPrincipal(tenant.id, 'e2e');
      try {
        await invoker.run(useCases.inviteMember, admin, {
          email,
          capabilities: ['tenant:admin'],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
      const { item } = await invoker.run(useCases.createItem, admin, {
        slug: `heading-${Date.now()}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: 'Met een kop' },
          blocks: [{ type: 'heading', version: 1, props: { text: { nl: 'Kop' } } }],
        },
      });
      return item.id;
    });
    const edit = `/admin/${slug}/content/${itemId}`;
    await login(page, edit, email, { 'accept-language': 'nl-NL' });
    await blocks({ heading: false });
    try {
      await page.reload();
      await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
      await expect(
        page.getByText('Het bloktype "Kop" hoort niet bij deze site.', { exact: false })
      ).toBeVisible();
      await uiLocale('en');
      await page.goto(edit);
      await page.getByRole('button', { name: 'Save', exact: true }).first().click();
      await expect(
        page.getByText('This site does not include the block type "Heading".', { exact: false })
      ).toBeVisible();
    } finally {
      await blocks({});
      await uiLocale(null);
    }
  });

  // #51: a refused settings save says what happened; `suspended` was called "check the fields".
  settingsTest('a refused settings save names a conflict and a suspension', async ({ page }) => {
    const project = test.info().project.name;
    const slug = `site-refusals-${project}`;
    const email = `site-refusals-${project}@probe.test`;
    const tenant = await asOwner((owner) =>
      testTenant(owner, slug, {
        name: 'Refused settings',
        locales: ['nl', 'en'],
        platformDomain: process.env['PLATFORM_DOMAIN']!,
        reuse: true,
      })
    );
    const status = (value: 'active' | 'suspended') =>
      asOwner((owner) =>
        owner.updateTable('tenants').set({ status: value }).where('id', '=', tenant.id).execute()
      );
    await status('active');
    await withInvoker(async (invoker) => {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(tenant.id, 'e2e'), {
          email,
          capabilities: ['tenant:admin'],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    });
    const evidence = settingsEvidence(test.info());
    evidence.watch('A', page);
    const save = (on: Page) => on.getByRole('button', { name: 'Tijdzone opslaan' }).click();
    try {
      await evidence.step('A: log in to settings', () => login(page, `/admin/${slug}/site`, email));
      const other = await evidence.step('B: open tab', () => page.context().newPage());
      evidence.watch('B', other);
      await evidence.step('B: load settings', () => other.goto(`/admin/${slug}/site`));
      await evidence.step('B: save settings', () => save(other));
      await evidence.step('B: close tab', () => other.close());
      await evidence.step('A: save stale settings', () => save(page));
      await evidence.step('A: conflict message', () =>
        expect(page.getByText('Deze instellingen zijn elders gewijzigd')).toBeVisible()
      );
      try {
        await evidence.step('suspend tenant', () => status('suspended'));
        await evidence.step('A: reload suspended settings', () => page.goto(`/admin/${slug}/site`));
        await evidence.step('A: save suspended settings', () => save(page));
        await evidence.step('A: suspension message', () =>
          expect(page.getByText('Deze site is opgeschort')).toBeVisible()
        );
      } finally {
        await evidence.step('restore active tenant', () => status('active'));
      }
    } finally {
      await evidence.attach();
    }
  });

  // Brief admin-entry § 1, 7: a page before the IdP, and what the IdP answered in words.
  test('the login page names the way in, and a refused login says so', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page.getByRole('heading', { level: 1, name: 'Inloggen' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('sessie is verlopen');
    await expect(page.locator('main')).toContainText('Je logt in met je account bij');
    await expectNoAxeViolations(page);

    await page.goto('/admin/callback?error=access_denied&state=stale');
    await expect(page.getByRole('heading', { level: 1, name: 'Inloggen mislukt' })).toBeVisible();
    await expect(page.locator('main')).toContainText('geannuleerd of geweigerd');
    await expect(page.getByRole('link', { name: 'Opnieuw proberen' })).toHaveAttribute(
      'href',
      '/admin/login'
    );
    await expectNoAxeViolations(page);
    await page.goto('/admin/callback?state=stale');
    await expect(page.locator('main')).toContainText('duurde langer dan tien minuten');
  });

  test('one site opens at once, and the way back keeps the picker', async ({ page }) => {
    await login(page, '/admin?all');
    await expect(page.getByRole('heading', { level: 1, name: 'Jouw sites' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Probe' })).toBeVisible();
    await expect(page.locator('main')).toContainText('Beheerder');
    await expectNoAxeViolations(page);
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/probe$/);

    await page.goto('/admin/logout');
    await page.getByRole('button', { name: 'Uitloggen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Je bent uitgelogd' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Opnieuw inloggen' })).toHaveAttribute(
      'href',
      '/admin/login'
    );
    await expectNoAxeViolations(page);
  });

  test('no cache may keep an admin page, and Back after signing out finds none', async ({
    page,
  }) => {
    onlyA11y('the header does not depend on the script');
    test.slow();
    await login(page, '/admin/probe');
    await page.goto('/admin/probe/content?type=page');
    const item = await page
      .locator('main a[href*="/admin/probe/content/"]')
      .first()
      .getAttribute('href');
    expect(item).toMatch(/\/content\/[0-9a-f-]{36}/);
    const paths = [
      ...ADMIN_ROUTES.map((route) => route.path),
      new URL(item!, 'http://admin.invalid').pathname,
      '/admin/probe/__data.json',
      '/admin/probe/bestaat-niet',
    ];
    for (const path of paths) {
      const { status, headers } = await page.request
        .get(path, { maxRedirects: 0 })
        .then((response) => ({ status: response.status(), headers: response.headers() }));
      expect(status, path).toBeLessThan(500);
      expect(headers['cache-control'], path).toBe('private, no-store');
      expect(headers['etag'], path).toBeUndefined();
    }

    await page.goto('/admin/probe/profiel');
    await page.goto('/admin/logout');
    await page.getByRole('button', { name: 'Uitloggen' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Je bent uitgelogd' })).toBeVisible();
    await page.goBack();
    await page.goBack();
    await expect(page).toHaveURL(/\/admin\/login\?return=/);
    await expect(page.locator('.admin-sidebar')).toHaveCount(0);
  });

  test('logging out empties what this origin kept in the browser', async ({ page }) => {
    onlyA11y('reads the browser storage');
    await login(page, '/admin?all');
    await page.goto('/admin/logout');
    await page.evaluate(() => {
      localStorage.setItem('probe', '1');
      sessionStorage.setItem('probe', '1');
    });
    const logout = page.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/admin/logout'
    );
    await page.getByRole('button', { name: 'Uitloggen' }).click();
    const headers = await (await logout).allHeaders();
    expect(headers['clear-site-data']).toBe('"cache", "storage"');
    await expect(page.getByRole('heading', { level: 1, name: 'Je bent uitgelogd' })).toBeVisible();
    expect(
      await page.evaluate(() => [localStorage.getItem('probe'), sessionStorage.getItem('probe')])
    ).toEqual([null, null]);
  });

  // `localhost` and 127.0.0.1 are two sites. The browser's own Fetch Metadata for a cross-site
  // fetch is read at a small server and replayed with the session: Playwright's request context
  // sends none, and the browser hides the admin's answer (Cross-Origin-Resource-Policy fails the
  // request before any response event), so a 403 here is the refusal and not a missing login.
  test('another site cannot use the admin, but can link to it', async ({ page, baseURL }) => {
    onlyA11y('the other site acts with a script');
    await login(page, '/admin/probe');
    let metadata: Record<string, string> = {};
    const other = createServer((req, res) => {
      if (req.url === '/seen')
        metadata = Object.fromEntries(
          Object.entries(req.headers).filter(([name]) => name.startsWith('sec-fetch-'))
        ) as Record<string, string>;
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>other</title>');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    try {
      const port = (other.address() as AddressInfo).port;
      await page.goto(`http://localhost:${port}/`);
      await page.evaluate(
        (url) => fetch(url, { mode: 'no-cors', credentials: 'include' }),
        `http://127.0.0.1:${port}/seen`
      );
      expect(metadata['sec-fetch-site']).toBe('cross-site');
      const target = `${baseURL}/admin/probe`;
      expect((await page.request.get(target, { headers: metadata })).status()).toBe(403);
      expect((await page.request.get(target)).status()).toBe(200);

      const followed = page.waitForResponse((r) => r.url() === target);
      await page.evaluate((url) => {
        const a = document.createElement('a');
        a.href = url;
        a.textContent = 'admin';
        document.body.append(a);
        a.click();
      }, target);
      expect((await followed).status()).toBe(200);
      await expect(page).toHaveURL(target);
    } finally {
      other.close();
    }
  });

  // Both halves in a real browser: the string is refused at the sink, on a public page and in the
  // admin, and the browser queues the report for this origin's collector. The queue is read over
  // the DevTools protocol, because the browser sends a batch up to a minute later.
  test('a string cannot reach a script sink, and the browser reports that here', async ({
    page,
  }) => {
    onlyA11y('the sink is written to by a script');
    await login(page, '/admin/probe');
    const cdp = await page.context().newCDPSession(page);
    const reports: { type: string; destination: string; body: Record<string, unknown> }[] = [];
    cdp.on('Network.reportingApiReportAdded', ({ report }) => reports.push(report));
    await cdp.send('Network.enableReportingApi', { enable: true });
    for (const path of ['/admin/probe', '/probe/signup']) {
      await page.goto(path);
      const outcome = await page.evaluate(() => {
        const refused = (act: () => unknown) => {
          try {
            act();
            return 'allowed';
          } catch (error) {
            return (error as Error).name;
          }
        };
        const types = (
          window as unknown as {
            trustedTypes: { createPolicy(name: string, rules: object): unknown };
          }
        ).trustedTypes;
        return {
          sink: refused(() => {
            document.body.innerHTML = '<i>written</i>';
          }),
          policy: refused(() => types.createPolicy('someone-else', {})),
        };
      });
      expect(outcome, path).toEqual({ sink: 'TypeError', policy: 'TypeError' });
    }
    await expect
      .poll(
        () =>
          reports.filter(
            (r) =>
              r.type === 'csp-violation' &&
              r.destination === 'default' &&
              r.body['blockedURL'] === 'trusted-types-sink'
          ).length
      )
      .toBeGreaterThanOrEqual(2);
  });

  test('the report collector takes a batch on any hostname and little else', async ({
    request,
  }) => {
    const post = (data: string, type = 'application/reports+json', host?: string) =>
      request.post('/_reports', {
        data,
        headers: { 'content-type': type, ...(host ? { host } : {}) },
      });
    const batch = JSON.stringify([{ type: 'csp-violation', url: 'https://x.example/', body: {} }]);
    expect((await post(batch)).status()).toBe(204);
    expect((await post(batch, undefined, 'probe.example.org')).status()).toBe(204);
    // Resolve a registered tenant first: an unknown host never exercises the slug rewrite.
    const tenantHost = 'probe.localhost:4173';
    expect((await request.get('/signup', { headers: { host: tenantHost } })).status()).toBe(200);
    expect((await post(batch, undefined, tenantHost)).status()).toBe(204);
    expect((await post(batch, 'application/json')).status()).toBe(415);
    expect((await post('{"type":"csp-violation"}')).status()).toBe(400);
    expect((await post('not json')).status()).toBe(400);
    expect((await post(`[${' '.repeat(64 * 1024)}]`)).status()).toBe(413);
    expect((await request.get('/_reports')).status()).toBe(405);
  });

  test('the admin is not served on another origin', async ({ request }) => {
    const res = await request.get('/admin', { headers: { host: 'probe.example.org' } });
    expect(res.status()).toBe(404);
  });

  // TODO #20c decisions 1, 2 and 4: the admin's headers and CSP, the origin check on its form
  // actions, and a fresh session cookie on every login. The Secure flag is in admin-paths.test.ts
  // (this gate runs on http).
  test('the admin sends its own headers and may not be framed at all', async ({
    page,
    request,
  }) => {
    const start = await request.get('/admin/login?return=/admin&start=1', {
      maxRedirects: 0,
    });
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
    expect(response!.headers()['vary']).toBe('cookie, accept-language');
  });

  test('an admin action posted from another origin is refused', async ({ request, baseURL }) => {
    const post = (origin: string) =>
      request.post('/admin/probe/site?section=api&/createKey', {
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        data: 'name=evil&role=author',
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
    await login(page, '/admin?all');
    const first = await session();
    expect(first).toBeTruthy();
    // A second login on the same browser, with the first session still present.
    await page.goto('/admin/login?return=/admin&start=1');
    await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
    await page.getByLabel('E-mail').fill(ADMIN);
    await page.getByRole('button', { name: 'Sign in' }).click();
    // ADMIN has one site, so the picker at /admin opens it (brief admin-entry § 4).
    await expect(page).toHaveURL(/\/admin\/probe$/);
    const second = await session();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect((await context.cookies()).some((c) => c.name === 'mycel_oidc')).toBe(false);
    const cookie = (await context.cookies()).find((c) => c.name === 'mycel_session');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/admin' });
  });
});

// Operator preferences (#88): an operator whose browser speaks English chooses Dutch and a
// time zone of their own; the menu changes language at once, and a planned time is typed and
// shown in their zone, named only while it differs from the site's. Its own operator, reset at
// the start, because the database outlives a run and the other specs negotiate on the browser.
// The page itself is a route of the generic UI gate (routes.ts).
test.describe('preferences', () => {
  const email = 'prefs-admin@probe.test';
  test.use({ locale: 'en-GB' });

  test.beforeAll(async () => {
    const probe = await tenantId();
    await withInvoker(async (invoker) => {
      try {
        await invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
          email,
          capabilities: ['tenant:admin'],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
    });
    await asOwner((owner) =>
      owner
        .updateTable('operators')
        .set({ ui_locale: null, time_zone: null, date_format: 'relative' })
        .where('email', '=', email)
        .execute()
    );
  });

  test('a chosen language and zone win over the browser on every admin page', async ({ page }) => {
    await login(page, '/admin/probe', email, { 'accept-language': 'en-GB' });
    const nav = (name: string) => page.getByRole('navigation', { name });
    await expect(nav('Site navigation').getByRole('link', { name: 'Pages' })).toBeAttached();

    await page.locator('.admin-account > summary').click();
    await page.getByRole('link', { name: 'Profile', exact: true }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Profile and preferences' })
    ).toBeVisible();
    // Inside the site's shell: the menu stays (trial 4b-8/9).
    await expect(page).toHaveURL(/\/admin\/probe\/profiel$/);
    await expect(nav('Site navigation').getByRole('link', { name: 'Pages' })).toBeAttached();
    // Your role per site sits on your profile (#101), not on Members.
    await expect(page.getByRole('listitem').filter({ hasText: 'Probe' })).toContainText(
      'Administrator'
    );
    await page.getByLabel('Language of the admin').selectOption('nl');
    await page.getByLabel('Time zone').selectOption('Asia/Tokyo');
    await page.getByRole('button', { name: 'Save preferences' }).click();
    await expect(page.getByText('Voorkeuren opgeslagen.')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    await expectNoAxeViolations(page);

    // Back to the site the operator came from: the menu speaks Dutch.
    await page.getByRole('link', { name: 'Terug', exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/probe$/);
    await expect(nav('Sitenavigatie').getByRole('link', { name: 'Pagina’s' })).toBeAttached();

    // A time typed in the operator's zone is planned in it, and named because it is not the site's.
    await page.goto('/admin/probe/content/new?type=page');
    await page.getByLabel('Titel (nl)').fill(`Tokio ${Date.now()}`);
    await page.getByLabel('Titel (en)').fill('Tokyo');
    await page.getByRole('button', { name: 'Concept maken' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
    const edit = new URL(page.url()).pathname;
    const nl = page.locator('#publication-nl');
    // Hydration restores the server's closed fold; interact only after the editor owns it.
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await openPublication(page);
    await nl.locator('details', { hasText: 'Inplannen' }).locator('summary').click();
    await expect(nl.getByText('Tijd in Asia/Tokyo')).toBeAttached();
    await nl.getByLabel('Publiceren op').fill('2030-01-04T17:00');
    await nl.getByRole('button', { name: 'Inplannen', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=schedule&locale=nl`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 17:00 (Asia/Tokyo)');

    // Back to the site's zone: the same instant, nine hours earlier on the clock, unnamed. The
    // profile outside any site (from the site picker) is the same form.
    await page.goto('/admin/voorkeuren');
    await page.getByLabel('Tijdzone').selectOption('');
    await page.getByRole('button', { name: 'Voorkeuren opslaan' }).click();
    await expect(page.getByText('Voorkeuren opgeslagen.')).toBeVisible();
    await page.goto(edit);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 09:00');
    await expect(nl).not.toContainText('(Europe/Amsterdam)');
  });
});

// Status page (TODO #17c, brief admin-operations-screens): a tenant administrator sees the
// verdict with the moment it was checked, a stuck task of the site in words with its recovery in
// the row, tries it again, closes another after confirming in its row, and reads a diagnosis
// without an address in it. Runs without JavaScript and under axe like the other admin specs; with
// JavaScript the page refreshes itself, and a refresh that fails or finds access gone turns the
// verdict into "Status onbekend" instead of leaving the old one standing. The UI gate (skill
// ui-action-layout) checks a task's actions and its open confirmation at 320 CSS px and 200% text.
//
// The stuck tasks go in as the worker leaves them (mycel_worker on the operator connection), with
// a type no handler knows and a run time a day ahead, so the e2e worker never takes them first.
test.describe('status', () => {
  test.use({
    locale: 'nl-NL',
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
  });

  /** As mycel_worker, the queue's own role: insert stuck jobs for tenant probe, or finish jobs. */
  async function asWorker(fn: (trx: Kysely<Database>, probeId: string) => Promise<void>) {
    const { createDb, createTenantDirectory } = await import('@mycel/db');
    const db = createDb(process.env['DATABASE_URL']!);
    try {
      const probe = await createTenantDirectory(db).findBySlug('probe');
      await asRole(db, 'mycel_worker', (trx) => fn(trx, probe!.id));
    } finally {
      await db.destroy();
    }
  }

  /** A stuck job of tenant probe; its type names the test, so each test finds only its own. */
  async function stuckJob(type: string): Promise<string> {
    const { uuidv7 } = await import('@mycel/db');
    const id = uuidv7();
    await asWorker(async (trx, probeId) => {
      await trx
        .insertInto('jobs')
        .values({
          id,
          tenant_id: probeId,
          type,
          key: `${type}:${id}`,
          run_at: new Date(Date.now() + 86_400_000),
          payload: JSON.stringify({ secret: 'e2e-payload' }),
          attempts: 10,
          max_attempts: 10,
          last_error: 'delivery failed for e2e-person@example.org',
        })
        .execute();
    });
    return id;
  }

  async function finish(ids: string[]) {
    await asWorker(async (trx) => {
      await trx
        .updateTable('jobs')
        .set({ done_at: new Date() })
        .where('id', 'in', ids)
        .where('done_at', 'is', null)
        .execute();
    });
  }

  /** A task's row; its technical type is in the folded details, so the row is found by it. */
  const row = (page: Page, type: string) => page.locator('#jobs li.ui-row', { hasText: type });
  const verdict = (page: Page) =>
    page.getByRole('region', { name: /aandacht|Alles loopt|onbekend/ });

  test('an administrator retries and closes a stuck task without JavaScript', async ({ page }) => {
    const run = `${test.info().project.name}-${Date.now()}`;
    const retried = `e2e.status.${run}.retry`;
    const closed = `e2e.status.${run}.close`;
    const ids = [await stuckJob(retried), await stuckJob(closed)];
    try {
      await login(page, '/admin/probe');
      await page
        .locator('.ui-navgroup-disclosure > summary')
        .filter({ hasText: /^Beheer$/ })
        .click();
      await page.getByRole('link', { name: 'Beheer', exact: true }).click();
      await page.getByRole('main').getByRole('link', { name: 'Status', exact: true }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();

      // The verdict first, with its moment and a link to where the task can be recovered.
      await expect(verdict(page)).toHaveClass(/attention/);
      await expect(verdict(page)).toContainText('Gecontroleerd');
      await expect(
        verdict(page).getByRole('link', { name: /mislukten? bij elke poging/ })
      ).toHaveAttribute('href', '#jobs');

      // In words first; the type and the attempts only behind "Technische details".
      await expect(row(page, retried).getByRole('heading', { level: 3 })).toHaveText('Andere taak');
      await expect(row(page, retried)).toContainText('10 keer mislukt');
      await expect(row(page, retried)).toContainText('delivery failed for [email]');
      await expect(row(page, retried).getByText(retried).first()).toBeHidden();
      await row(page, retried).getByText('Technische details').click();
      await expect(row(page, retried)).toContainText('10 van 10');
      await expect(page.locator('main')).not.toContainText('e2e-payload');
      await expectNoAxeViolations(page);

      // The diagnosis is on the page, folded and redacted, before anyone shares it.
      await page.getByText('Toon de diagnose').click();
      const diagnosis = page.locator('pre.diagnosis');
      await expect(diagnosis).toContainText('site: probe');
      await expect(diagnosis).toContainText(`- ${retried} `);
      await expect(diagnosis).not.toContainText('@');
      await expect(page.getByLabel('Diagnose, om te selecteren en kopiëren')).toHaveValue(
        /site: probe/
      );

      await row(page, retried).getByRole('button', { name: 'Opnieuw proberen' }).click();
      await expect(page.locator('.ui-notice[role="status"]')).toContainText(
        'De taak draait opnieuw'
      );
      await expect(row(page, retried)).toHaveCount(0);

      // Closing asks first, in the row; a disclosure, so it works without JS too.
      await row(page, closed).getByText('Afsluiten', { exact: true }).click();
      await expect(row(page, closed)).toContainText('De taak draait niet meer');
      await expectNoAxeViolations(page);
      await row(page, closed)
        .getByRole('button', { name: /Ja, sluit deze taak af/ })
        .click();
      await expect(page.locator('.ui-notice[role="status"]')).toContainText(
        'De taak is afgesloten.'
      );
      await expect(row(page, closed)).toHaveCount(0);

      // Both recoveries are in the latest actions.
      const actions = page.getByRole('region', { name: 'Laatste acties' });
      await expect(actions).toContainText('Vastgelopen taak afgesloten');
      await expect(actions).toContainText('Vastgelopen taak opnieuw geprobeerd');

      // The log has them too, by the member's name, and its filter is a GET form without JS.
      await actions.getByRole('link', { name: 'Alle acties in het logboek' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Logboek' })).toBeVisible();
      await page.getByLabel('Handeling').selectOption({ label: 'Vastgelopen taak afgesloten' });
      await page.getByRole('button', { name: 'Filteren' }).click();
      await expect(page).toHaveURL(/operation=ops\.job\.close/);
      const log = page.locator('#audit-table tbody tr');
      await expect(log.first()).toContainText('Vastgelopen taak afgesloten');
      await expect(log.first()).toContainText('Gelukt');
      await expect(log.first()).not.toContainText('Een teamlid');
      await expect(page.locator('#audit-table')).not.toContainText('opnieuw geprobeerd');
      await expectNoAxeViolations(page);
    } finally {
      await finish(ids);
    }
  });

  test('with JavaScript it refreshes itself, and a failed refresh is never a green verdict', async ({
    page,
  }) => {
    onlyA11y('the refresh is a script');
    const type = `e2e.status.${test.info().project.name}-${Date.now()}.refresh`;
    const ids: string[] = [];
    let mode: 'pass' | 'fail' | 'forbidden' = 'pass';
    await page.route('**/admin/probe/status', (route) => {
      if (route.request().resourceType() !== 'fetch' || mode === 'pass') return route.continue();
      return mode === 'fail' ? route.abort() : route.fulfill({ status: 403, body: '' });
    });
    const refresh = () =>
      page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    try {
      await login(page, '/admin/probe/status');
      await expect(page.getByText('Deze pagina vernieuwt zichzelf elke minuut.')).toBeVisible();
      await expect(row(page, type)).toHaveCount(0);

      // A task gets stuck while the page is open: the next refresh shows it without a reload.
      ids.push(await stuckJob(type));
      await refresh();
      await expect(row(page, type)).toHaveCount(1);
      await expect(verdict(page)).toHaveClass(/attention/);

      mode = 'fail';
      await refresh();
      await expect(page.getByRole('heading', { level: 2, name: 'Status onbekend' })).toBeVisible();
      await expect(verdict(page)).toHaveClass(/unknown/);
      await expect(page.getByRole('alert')).toContainText('Vernieuwen lukte niet');

      mode = 'forbidden';
      await refresh();
      await expect(page.getByRole('alert')).toContainText('Je hebt geen toegang meer');
      await expectNoAxeViolations(page);

      mode = 'pass';
      await refresh();
      await expect(page.getByRole('heading', { level: 2, name: 'Status onbekend' })).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
    } finally {
      await finish(ids);
    }
  });

  test.describe('UI gate: the status action groups at 320 CSS px and 200% text', () => {
    test.use({ viewport: NARROW });

    for (const text of TEXT_SIZES) {
      test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
        onlyA11y('measures the layout with a script');
        const type = `e2e.status.gate.${text.replace('%', '')}.${Date.now()}`;
        const id = await stuckJob(type);
        try {
          await login(page, '/admin/probe/status');
          const measure = async (name: string) => {
            await setTextSize(page, text);
            await layoutGate(page, name, 'main');
          };
          await measure('job');
          await row(page, type).getByText('Afsluiten', { exact: true }).click();
          await expect(
            row(page, type).getByRole('button', { name: /Ja, sluit deze taak af/ })
          ).toBeVisible();
          await measure('confirm');
          await row(page, type).getByText('Technische details').click();
          await measure('details');
        } finally {
          await finish([id]);
        }
      });
    }
  });
});

// Managed connection controls use native posts and the same registry as HTTP/MCP. The fixture's
// destination passes the configuration check through a fake DNS answer; the worker checks DNS
// again itself before any send. A seeded `unknown` intent proves the manual resolution path.
test.describe('connections', () => {
  async function fixture() {
    const principal = systemPrincipal(await tenantId(), 'e2e');
    const purpose = `Synthetic webhook ${test.info().project.name} ${Date.now()}`;
    return withInvoker(
      async (invoker, uow) => {
        const connection = await invoker.run(useCases.createConnection, principal, {
          provider: 'webhook',
          accountRef: null,
          externalOwner: 'Synthetic owner',
          maintainer: 'Synthetic operator',
          purpose,
          direction: 'outbound',
          dataAuthority: 'mycel',
          consentAuthority: 'mycel',
          consentScopes: ['newsletter:main'],
          formIds: [],
          destination: 'https://hooks.example.org/mycel',
          contractVersion: 'v1',
          adapterVersion: 'v1',
        });
        // An earlier attempt whose outcome the receiver never proved; a webhook cannot reconcile it.
        const at = new Date();
        await uow.run(principal, (ctx) =>
          ctx.connectionIntents.insert({
            id: uuidv7Ids.next(),
            connectionId: connection.id,
            businessId: uuidv7Ids.next(),
            connectionVersion: connection.version,
            credentialVersion: 1,
            source: SYNTHETIC_SOURCE,
            mappingVersion: 'v1',
            supporterId: null,
            scope: SYNTHETIC_SCOPE,
            actor: { kind: 'system', id: 'e2e' },
            key: `e2e-${uuidv7Ids.next()}`,
            state: 'unknown',
            failure: 'ambiguous',
            attempts: 1,
            revision: 0,
            leaseToken: null,
            leaseUntil: null,
            nextAt: at,
            createdAt: at,
            updatedAt: at,
          })
        );
        return { purpose, id: connection.id };
      },
      {
        dns: new FakeDns({ 'hooks.example.org': ['8.8.8.8'] }),
        connectionCredentialKey: process.env['CONNECTION_CREDENTIAL_KEY'],
      }
    );
  }

  for (const locale of ['nl-NL', 'en-US']) {
    test.describe(`managed connections ${locale}`, () => {
      test.use({
        viewport: NARROW,
        locale,
      });

      test('list, own page, controls and UI gate at 320 CSS px and 200% text', async ({ page }) => {
        const f = await fixture();
        const nl = locale.startsWith('nl');
        await login(page, '/admin/probe/connections');
        // The list names the stand in words: the unknown attempt asks attention.
        const row = page.locator('#connections-table tbody tr', { hasText: f.purpose });
        await expect(row).toContainText(nl ? 'Vraagt aandacht' : 'Needs attention');
        if (isA11y()) {
          await setTextSize(page, '200%');
          await layoutGate(page, 'connections', 'main');
          await expectNoAxeViolations(page);
          await setTextSize(page, '100%');
        }
        await row.getByRole('link', { name: f.purpose }).click();
        await expect(page.getByRole('heading', { level: 1, name: f.purpose })).toBeVisible();

        const main = page.locator('main');
        const credential = main.locator('form[action="?/credential"]');
        await credential
          .getByLabel(nl ? 'Nieuwe sleutel' : 'New signing secret')
          .fill('e2e-synthetic-secret');
        await credential.getByRole('button').click();
        await expect(main).toContainText(nl ? 'Er is een sleutel ingesteld' : 'A secret is set');
        await expect(page.locator('body')).not.toContainText('e2e-synthetic-secret');
        await main
          .getByRole('button', { name: nl ? 'Aflevering hervatten' : 'Resume delivery' })
          .click();
        await main.getByRole('button', { name: nl ? 'Proef versturen' : 'Send test' }).click();
        const attempts = page.locator('#attempts-table');
        await expect(attempts).toContainText(
          nl ? 'Proef, geen persoon gekopieerd' : 'Test, no person copied'
        );
        if (isA11y()) {
          await setTextSize(page, '200%');
          await layoutGate(page, 'connection', 'main');
          await expectNoAxeViolations(page);
        }
        // The unknown attempt offers only a manual close, never a retry. The synthetic test sent
        // above is a separate, pending attempt and may keep its own retry.
        const unknown = attempts.locator('tbody tr', {
          hasText: nl ? 'Uitkomst onbekend' : 'Outcome unknown',
        });
        await expect(unknown).toContainText(
          nl ? 'Mycel weet niet of de ontvanger' : 'Mycel cannot tell whether'
        );
        await expect(unknown.getByRole('button')).toHaveCount(1);
        await unknown
          .getByRole('button', { name: nl ? 'Markeer als afgehandeld' : 'Mark as handled' })
          .click();
        await expect(attempts).toContainText(nl ? 'Handmatig afgehandeld' : 'Handled by hand');
        await main
          .getByRole('button', { name: nl ? 'Aflevering pauzeren' : 'Pause delivery' })
          .click();
        await expect(main).toContainText(nl ? 'De aflevering is gepauzeerd' : 'Delivery is paused');
        await main
          .getByRole('button', { name: nl ? 'Koppel los' : 'Disconnect', exact: true })
          .click();
        await expect(
          page.getByRole('heading', {
            name: nl ? 'Deze koppeling ontkoppelen?' : 'Disconnect this connection?',
          })
        ).toBeVisible();
        await page
          .getByRole('button', { name: nl ? 'Ja, koppel los' : 'Confirm disconnect' })
          .click();
        await expect(main).toContainText(nl ? 'Losgekoppeld' : 'Disconnected');
        await expect(
          main.getByRole('button', { name: nl ? 'Aflevering hervatten' : 'Resume delivery' })
        ).toHaveCount(0);
      });
    });
  }
});

// Hostnames (TODO #14, ADR 014): the site served from `Host` on its platform hostname
// probe.localhost (Chromium resolves *.localhost to loopback), a verified non-primary hostname
// redirecting to the primary, the admin never on a tenant hostname, Caddy's `allowed` question,
// and the admin's domain section without JavaScript and under axe. scripts/e2e/e2e.mjs runs both
// processes with SITE_URL_MODE=hostnames, so the confirmation mail links to probe.localhost; the
// development path form stays covered by signup.spec.ts.
test.describe('hostnames', () => {
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
    await expect
      .poll(find, { timeout: 15_000, message: `confirmation mail to ${to}` })
      .toBeTruthy();
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
    expect((await request.get('/signup', { headers: { host: 'nope.example' } })).status()).toBe(
      404
    );
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
  // The table in docs/reference/hostnames.md. An address that answers on the site and the platform
  // origin makes the refusal below it mean something.
  test('the discovery documents answer per kind of host', async ({ request }) => {
    onlyA11y('reads raw HTTP responses, so one project is enough');
    const get = (host: string, path: string) =>
      request.get(path, { headers: { host }, maxRedirects: 0 });
    const CONTACT = 'Contact: mailto:security@probe.test';
    const SECURITY = '/.well-known/security.txt';
    const CATALOG = '/.well-known/api-catalog';
    const anchor = async (host: string) => {
      const body = (await (await get(host, CATALOG)).json()) as { linkset: { anchor: string }[] };
      return new URL(body.linkset[0]?.anchor ?? '').pathname;
    };

    // A registered site first: the reroute hook only rewrites for a host it resolves.
    const site = 'probe.localhost:4173';
    expect(await (await get(site, SECURITY)).text()).toContain(CONTACT);
    expect(await anchor(site)).toBe('/v1/sites/probe');

    const origin = new URL(test.info().project.use.baseURL ?? '').host;
    expect(await (await get(origin, SECURITY)).text()).toContain(CONTACT);
    expect(await anchor(origin)).toBe('/v1');

    for (const path of [SECURITY, CATALOG]) {
      expect((await get('nope.example.org', path)).status(), `unknown host: ${path}`).toBe(404);
      expect((await get(site, `/probe${path}`)).status(), `under a slug: ${path}`).toBe(404);
    }

    // A verified, non-primary hostname takes the same decision as a page.
    const alias = await get('e2e-alias.example', SECURITY);
    expect(alias.status()).toBe(301);
    expect(alias.headers()['location']).toBe(`${SITE}${SECURITY}`);

    const page = await get(site, '/signup');
    expect(page.status()).toBe(200);
    expect(page.headers()['link']).toContain('</.well-known/api-catalog>; rel="api-catalog"');
    // What an agent sees of a page it only asked the headers of.
    const head = await request.head('/signup', { headers: { host: site }, maxRedirects: 0 });
    expect(head.headers()['link']).toContain('rel="api-catalog"');
    const admin = await request.get('/admin/login', { headers: { host: origin }, maxRedirects: 0 });
    expect(admin.headers()['link'] ?? '').not.toContain('api-catalog');
  });

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
});

// Self-service export (TODO #28): a site administrator asks for an archive, the e2e worker builds
// it, and the download is a tar in the format `mycel import` reads (its manifest first). Runs
// without JavaScript and under axe like the other admin specs; the UI gate (skill
// ui-action-layout) checks the ask button, the download and the history at 320 CSS px and 200%
// text.
// An ask while one is being built gets that one back, so the two projects may share an archive.
test.describe('export', () => {
  const run = promisify(execFile);

  test.use({
    locale: 'nl-NL',
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
  });

  /** Create an export (or get the one being prepared) and reload until one can be downloaded. */
  async function readyArchive(page: Page) {
    await page.getByRole('button', { name: 'Export maken' }).click();
    await expect(page.locator('.ui-notice[role="status"]')).toContainText('export');
    // The newest ready archive has a section of its own, whatever another project asked since.
    const latest = page.getByRole('region', { name: 'Nieuwste archief' });
    await expect(async () => {
      await page.goto('/admin/probe/export');
      await expect(latest).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 90_000, intervals: [1000, 2000, 3000] });
    return latest;
  }

  test('an administrator asks for an archive and downloads it without JavaScript', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    // Status links to Export (#116); the route through Manage is in the admin-shell test (#114).
    await login(page, '/admin/probe/status');
    await page.getByRole('link', { name: 'Een export van deze site maken' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Export' })).toBeVisible();
    await expect(page.locator('main')).toContainText('7 dagen te downloaden');
    await expectNoAxeViolations(page);

    const latest = await readyArchive(page);
    await expect(latest).toContainText('te downloaden tot');
    const link = latest.getByRole('link', { name: 'Archief downloaden' });
    // The history says the status in words and who asked by name, never an actor reference.
    const history = page.locator('#export-table');
    await expect(history).toContainText('Klaar');
    await expect(history).not.toContainText('operator:');
    await latest.getByText('Technische details').click();
    await expect(latest).toContainText(/[0-9a-f]{64}/);
    await expectNoAxeViolations(page);

    // Through the page's own session, as media.spec.ts downloads an original: a browser download
    // would leave out the test's forwarded-address headers, which the server here requires.
    const href = (await link.getAttribute('href'))!;
    expect(href).toMatch(/^\/admin\/probe\/export\/[0-9a-f-]{36}\?exp=\d+&sig=/);
    expect(await link.getAttribute('download')).not.toBeNull();
    const response = await page.request.get(href);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('application/x-tar');
    expect(response.headers()['content-disposition']).toMatch(
      /^attachment; filename="probe-\d{4}-\d{2}-\d{2}\.tar"$/
    );
    expect(response.headers()['cache-control']).toBe('private, no-store');
    const file = test.info().outputPath('probe.tar');
    await writeFile(file, await response.body());
    const { stdout } = await run('tar', ['-tf', file]);
    expect(stdout.split('\n')).toContain('./manifest.json');
    expect(stdout).toContain('./tables/supporters.ndjson');

    // The link is bound to the archive and expires; without its signature it is a 404.
    const bare = await page.request.get(href.split('?')[0]!);
    expect(bare.status()).toBe(404);
  });

  test.describe('UI gate: the export actions at 320 CSS px and 200% text', () => {
    test.use({ viewport: NARROW });

    for (const text of TEXT_SIZES) {
      test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
        onlyA11y('measures the layout with a script');
        test.setTimeout(120_000);
        await login(page, '/admin/probe/export');
        await readyArchive(page);
        await setTextSize(page, text);
        await layoutGate(page, 'export actions', 'main');
      });
    }
  });
});

// #79 PR 2: the actions of one row of the content list, and the dashboard's content widgets.
test.describe('content-list-rows', () => {
  test.use({ locale: 'nl-NL' });

  test('a row opens the site and the preview, copies, takes offline; a phone gets one menu', async ({
    page,
    request,
  }) => {
    requireApi();
    const word = `rij${randomUUID().slice(0, 8)}`;
    const { item } = await callApi<{ item: { id: string; latestRevisionId: string } }>(
      request,
      'content.item.create',
      {
        slug: `row-${word}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: `Brood ${word}` },
          blocks: [],
        },
      }
    );
    const list = `/admin/probe/content?type=page&q=${word}&sort=title`;
    const row = page.locator(`[id="item-${item.id}"]`);
    await login(page, list);

    // A draft has a preview and no live page, and nothing to take offline.
    await row.hover();
    const actions = row.locator('.ui-row-actions.inline');
    await expect(actions.getByRole('link', { name: `Voorbeeld: Brood ${word}` })).toHaveAttribute(
      'href',
      `/admin/probe/preview/item/${item.id}?revision=${item.latestRevisionId}&locale=nl`
    );
    await expect(actions.getByRole('link', { name: /^Op de site/ })).toHaveCount(0);
    await expect(actions.getByText('Offline halen')).toHaveCount(0);

    // Live and unchanged: the site, no second look at the same thing.
    const probe = await tenantId();
    await withInvoker((invoker) =>
      invoker.run(useCases.publishItem, systemPrincipal(probe, 'e2e'), {
        itemId: item.id,
        revisionId: item.latestRevisionId,
        locale: 'nl',
      })
    );
    await page.reload();
    await row.hover();
    await expect(actions.getByRole('link', { name: /^Op de site/ })).toBeVisible();
    await expect(actions.getByRole('link', { name: /^Voorbeeld/ })).toHaveCount(0);
    await expectNoAxeViolations(page);

    // Live with newer changes: both, named apart. All four actions fit just above the width
    // where the menu takes over, with no scrolling inside the table.
    await callApi(request, 'content.item.update', {
      itemId: item.id,
      baseRevisionId: item.latestRevisionId,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: `Brood ${word}` },
        lead: { nl: 'Gewijzigd.' },
        blocks: [],
      },
    });
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.reload();
    await row.hover();
    await expect(actions.getByRole('link', { name: /^Op de site/ })).toBeVisible();
    await expect(actions.getByRole('link', { name: /^Voorbeeld/ })).toBeVisible();
    const region = page.locator('.ui-table-scroll');
    expect(await region.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(0);

    // One menu at 320 CSS px and 200% text, with every label whole; the column is gone.
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await expect(actions).toBeHidden();
    await row.locator('.ui-row-menu > summary').click();
    await expect(row.locator('.ui-row-menu').getByText('Dupliceren')).toBeVisible();
    await layoutGate(page, 'content list with an open row menu');
    // The table scrolls in its own region, which the page gate does not see: no action behind it.
    const menu = row.locator('.ui-row-menu');
    for (const action of await menu.locator('a, summary, button:visible').all())
      expect(await action.evaluate((e) => e.getBoundingClientRect().right)).toBeLessThanOrEqual(
        NARROW.width
      );
    await expectNoAxeViolations(page);
    await setTextSize(page, '100%');
    await page.setViewportSize({ width: 1280, height: 800 });

    // Taken offline after a question in the row; the same view, and it says so.
    await page.reload();
    await row.hover();
    await actions.locator('summary').click();
    await actions.getByRole('button', { name: `Ja, offline halen: Brood ${word}` }).click();
    await expect(page).toHaveURL(new RegExp(`done=offline#item-${item.id}$`));
    await expect(page.getByText('Offline gehaald in nl.')).toBeVisible();
    await expect(row.locator('.ui-badge')).toHaveText('offline');

    // Planned, it is on the dashboard; the widget links to an item and says when.
    await withInvoker((invoker) =>
      invoker.run(useCases.scheduleItem, systemPrincipal(probe, 'e2e'), {
        itemId: item.id,
        revisionId: item.latestRevisionId,
        locale: 'nl',
        at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      })
    );
    await page.goto('/admin/probe');
    const planned = page.getByRole('region', { name: 'Ingepland' }).getByRole('listitem');
    await expect(planned.first().getByRole('link')).toHaveAttribute('href', /\/content\//);
    await expect(planned.first().locator('time')).toBeVisible();
    await page.goto(list);

    // Duplicating opens a draft of its own.
    await row.hover();
    await actions.getByRole('button', { name: `Dupliceren: Brood ${word}` }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
    expect(page.url()).not.toContain(item.id);
    await expect(page.locator('[name="title.nl"]')).toHaveValue(`Kopie van Brood ${word}`);
    await page.goto(list);
    await expect(page.locator('#content-table tbody th > a')).toHaveText([
      `Brood ${word}`,
      `Kopie van Brood ${word}`,
    ]);
  });
});
