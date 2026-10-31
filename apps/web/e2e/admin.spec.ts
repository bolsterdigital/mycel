// flow: access
// Who may administer a site, and what the admin shows them: sign-in, membership, API keys, the
// tenant shell across sites, the status page and managed connections. Each part below was a spec
// of its own until TODO #50 folded the suite to its budget (testing.md § End-to-end flows); each
// keeps its own fixtures in its own describe.

import {
  Invoker,
  SYNTHETIC_SCOPE,
  capabilitiesFor,
  SYNTHETIC_SOURCE,
  UseCaseError,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeDns } from '@mycel/core/testing';
import { type Database, uuidv7Ids } from '@mycel/db';
import { asRole, testTenant } from '@mycel/db/testing';
import { type Page, expect, test } from '@playwright/test';
import type { Kysely } from 'kysely';
import { expectNoAxeViolations } from './lib/axe';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { ADMIN, login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { requireApi } from './lib/api';

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
    await expect(page.getByRole('heading', { level: 1, name: 'Leden' })).toBeVisible();
    await expect(
      page.locator('.admin-sidebar-bottom').getByText('e2e-admin@probe.test')
    ).toBeVisible();
    await expect(
      page.locator('.admin-sidebar-bottom').getByRole('button', { name: 'Uitloggen' })
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
    // Keys live under Settings, API access (#101); Members links there.
    await page.getByRole('link', { name: /API-toegang/ }).click();
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
    await login(page, '/admin');
    const first = await session();
    expect(first).toBeTruthy();
    // A second login on the same browser, with the first session still present.
    await page.goto('/admin/login?return=/admin&start=1');
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
});

// The tenant shell is one navigation surface across routes, locales and site memberships.
// A second, empty site catches stale site names and links when changing tenants.
test.describe('admin-shell', () => {
  const email = 'shell-admin@probe.test';
  const other = 'shell-other';
  // A live API key whose name has no break opportunity, long enough to overflow with any font. Its
  // revoke button once repeated the name and was clipped (TODO #63); the whole overview is now
  // measured at 320 CSS px and 200% text on every run and platform, that button included.
  const unbroken = 'newsletter_sync_production_e2e_a11y_1761600000000';

  /** Runs one use case as the system on tenant probe, outside the browser. */
  async function onProbe<T>(run: (invoker: Invoker, tenantId: string) => Promise<T>): Promise<T> {
    const probe = await tenantId();
    return withInvoker((invoker) => run(invoker, probe));
  }

  test.beforeAll(async () => {
    const probe = await tenantId();
    const tenant = await asOwner((owner) =>
      // Fixed slug, reused on a database that outlives the run: the test clicks it by name.
      testTenant(owner, other, {
        name: 'Second editorial site',
        locales: ['en', 'nl'],
        platformDomain: process.env['PLATFORM_DOMAIN']!,
        reuse: true,
      })
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

  /** At 320 CSS px the navigation is one ☰ bar, closed on every page load (#66 PR 1). */
  async function openMenu(page: Page) {
    const summary = page.locator('.admin-menu > summary');
    if ((await summary.isVisible()) && (await page.locator('.admin-menu[open]').count()) === 0)
      await summary.click();
  }

  async function checkShell(page: Page, name: string, current: string) {
    await openMenu(page);
    await expect(page.locator('.admin-site-name')).toHaveText(name);
    await expect(
      page
        .getByRole('navigation', { name: /sitenavigatie|site navigation/i })
        .getByRole('link', { name: current })
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('main')).toHaveCount(1);
    if (isA11y()) await expectNoAxeViolations(page);
    else {
      const all = await page
        .locator('script')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({ src: node.getAttribute('src'), type: node.getAttribute('type') }))
        );
      // The content editor's live preview, the media pickers' search and upload and the media
      // upload's thumbnails are optional modules, inert in this project; the native flows remain
      // the no-JS contract. Other shell routes still emit no script.
      const path = new URL(page.url()).pathname;
      const picker = (s: { src: string | null }) => s.src === '/_admin/media-picker.js';
      // Every tenant route carries the menu's collapse script (#87), a classic one in <head>.
      expect(all).toContainEqual({ src: '/_admin/nav.js', type: null });
      // The edit screen's sections become tabs with a module of their own (#66 PR 3).
      const tabs = { src: '/_admin/tabs.js', type: 'module' };
      if (/\/content\/[^/]+$/.test(path)) expect(all).toContainEqual(tabs);
      const scripts = all.filter(
        (s) => !picker(s) && s.src !== '/_admin/nav.js' && s.src !== tabs.src
      );
      if (all.some(picker)) {
        expect(path).toMatch(/\/content\/[^/]+$/);
        expect(all.filter(picker).every((s) => s.type === 'module')).toBe(true);
      }
      expect(scripts).toEqual(
        /\/content\/[^/]+$/.test(path)
          ? [{ src: '/_admin/live-preview-parent.js', type: 'module' }]
          : /\/media$/.test(path)
            ? [{ src: '/_admin/file-preview.js', type: 'module' }]
            : []
      );
    }
  }

  test('site navigation persists through content, editor, media, settings and a second tenant', async ({
    page,
  }) => {
    await login(page, '/admin/probe', email);
    await checkShell(page, 'Probe', 'Dashboard');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages' })
      .click();
    await checkShell(page, 'Probe', 'Pages');
    await expect(page.locator('#content-table tbody tr').first()).toBeVisible();
    await page.locator('#content-table tbody th a').first().click();
    await checkShell(page, 'Probe', 'Pages');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Media' })
      .click();
    await checkShell(page, 'Probe', 'Media');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Settings' })
      .click();
    await expect(page).toHaveURL(/\/admin\/probe\/site$/);
    // The subjects of Settings sit under it in the sidebar (#81-rest), not as tabs on the page.
    const sections = page
      .getByRole('navigation', { name: 'Site navigation' })
      .locator('.ui-navgroup-sub');
    // Seven since API access joined them (#101).
    await expect(sections.getByRole('link')).toHaveCount(7);
    await expect(sections.getByRole('link', { name: 'General' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(page.getByRole('main').locator('.ui-subnav')).toHaveCount(0);
    await sections.getByRole('link', { name: 'Theme' }).click();
    await expect(page).toHaveURL(/\/admin\/probe\/site\?section=theme$/);
    await expect(sections.getByRole('link', { name: 'Theme' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await page.getByRole('link', { name: 'Back to your sites' }).click();
    await page.getByRole('main').getByRole('link', { name: 'Second editorial site' }).click();
    await checkShell(page, 'Second editorial site', 'Dashboard');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages' })
      .click();
    await expect(page.locator('#content-table tbody tr')).toHaveCount(0);
    await checkShell(page, 'Second editorial site', 'Pages');
    await expect(page.locator('body')).not.toContainText('Probe');
  });

  // #66 PR 1: the dashboard first, then three groups with short labels and icons; an article is
  // marked as an article in its list, its editor and its writer. Axe in both schemes.
  test('the dashboard has six widgets and the navigation three groups', async ({ page }) => {
    await login(page, '/admin/probe', email);
    await checkShell(page, 'Probe', 'Dashboard');
    await expect(page.locator('.admin-menu > summary')).toBeHidden();
    await expect(page.locator('.ui-dashboard > .ui-widget')).toHaveCount(6);
    await expect(page.locator('.ui-widget.empty')).toHaveCount(5);
    // Two columns on a wide screen, never three (brief edit-screen § 4).
    expect(
      await page
        .locator('.ui-dashboard > .ui-widget')
        .evaluateAll(
          (nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().left))).size
        )
    ).toBe(2);
    await expect(page.getByRole('region', { name: 'Usage and limits' })).toContainText(
      'Supporters'
    );
    await expect(page.getByRole('region', { name: 'Waiting for you' })).toContainText(
      'Coming later.'
    );
    const nav = page.getByRole('navigation', { name: 'Site navigation' });
    for (const [group, links] of [
      ['Content', ['Pages', 'Articles']],
      ['Library', ['Media']],
      // AI assistance is a section of Settings (#81 PR 3), not a menu item.
      ['Manage', ['Settings', 'Members', 'Domains', 'Connections', 'Export', 'Status']],
    ] as const)
      await expect(nav.getByRole('list', { name: group }).getByRole('link')).toHaveText([...links]);
    await expect(nav.getByRole('link', { name: 'Overview' })).toHaveCount(0);
    await expect(page.locator('.admin-site-name')).toHaveAttribute('href', '/admin/probe');
    if (isA11y()) await expectNoAxeViolations(page, { dark: true });

    await nav.getByRole('link', { name: 'Articles' }).click();
    await checkShell(page, 'Probe', 'Articles');
    if (isA11y()) await expectNoAxeViolations(page, { dark: true });
    // The article editor loads no live preview, unlike the page editor checkShell expects, so
    // its mark is checked here directly.
    await page.locator('#content-table tbody th a').first().click();
    await expect(nav.getByRole('link', { name: 'Articles' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await page.goto(`${new URL(page.url()).pathname}/write`);
    await expect(nav.getByRole('link', { name: 'Articles' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(nav.getByRole('link', { name: 'Pages' })).not.toHaveAttribute('aria-current');
  });

  // #66 PR 4 (Jaap 2026-10-30, zoomed out): the workspace stands at one distance from the
  // sidebar and grows with the window, instead of a capped page centred further and further away.
  test('the workspace keeps its place beside the sidebar and grows on a wide screen', async ({
    page,
  }) => {
    await login(page, '/admin/probe/content?type=page', email);
    const measure = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      return page.evaluate(() => {
        const side = document.querySelector('.admin-sidebar')!.getBoundingClientRect();
        const main = document
          .querySelector('.admin-workspace .page.admin')!
          .getBoundingClientRect();
        return { gap: Math.round(main.left - side.right), width: Math.round(main.width) };
      });
    };
    const normal = await measure(1280);
    const wide = await measure(2560);
    expect(wide.gap).toBe(normal.gap);
    expect(wide.width - normal.width).toBe(1280);
  });

  for (const locale of ['nl', 'en']) {
    test.describe(`sidebar language ${locale}`, () => {
      test.use({ locale });
      test(`sidebar follows its longest label and reflows in ${locale}`, async ({ page }) => {
        await login(page, '/admin/probe/content?type=page', email, { 'accept-language': locale });
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await page.setViewportSize({ width: 1280, height: 900 });
        const metrics = await page.locator('.admin-sidebar').evaluate((sidebar) => {
          const links = [...sidebar.querySelectorAll('.ui-navgroup > ul > li > a')];
          const longest = Math.max(
            ...links.map((link) => {
              const range = document.createRange();
              range.selectNodeContents(link.querySelector('span')!);
              return range.getBoundingClientRect().width;
            })
          );
          const active = sidebar.querySelector('[aria-current]')!.getBoundingClientRect();
          return {
            width: sidebar.getBoundingClientRect().width,
            longest,
            edge: sidebar.getBoundingClientRect().right - active.right,
          };
        });
        expect(metrics.width - metrics.longest).toBeLessThan(100);
        expect(metrics.edge).toBeLessThan(2);
        await page.setViewportSize(NARROW);
        await setTextSize(page, '200%');
        await page.locator('.admin-menu > summary').click();
        await layoutGate(page, `sidebar ${locale}`, '.admin-sidebar');
        await page.screenshot({
          path: test.info().outputPath(`sidebar-${locale}-320-200.png`),
          fullPage: true,
        });
      });
    });
  }

  test.describe('narrow dashboard', () => {
    test.use({ viewport: NARROW });
    test('stacks the widgets in one column behind a closed ☰ bar', async ({ page }) => {
      await login(page, '/admin/probe', email);
      await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
      await expect(page.getByRole('navigation', { name: 'Site navigation' })).toBeHidden();
      const lefts = await page
        .locator('.ui-dashboard > .ui-widget')
        .evaluateAll(
          (nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().left))).size
        );
      expect(lefts).toBe(1);
      await page.locator('.admin-menu > summary').click();
      await checkShell(page, 'Probe', 'Dashboard');
    });
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

  /** Members, API access and an editor at 320 CSS px and 200% text: reflow, targets, whole labels. */
  async function narrowOverview(page: Page) {
    await login(page, '/admin/probe/leden', email);
    await setTextSize(page, '200%');
    // Closed by default on a phone; the ☰ bar opens and closes it from the keyboard.
    await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
    await expect(page.getByRole('navigation', { name: 'Site navigation' })).toBeHidden();
    const menu = page.getByText('Menu', { exact: true });
    await menu.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.admin-menu')).toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await expect(page.locator('.admin-menu')).not.toHaveAttribute('open');
    await page.keyboard.press('Enter');
    await layoutGate(page, 'members with the menu open');
    await page
      .getByRole('navigation', { name: 'Site navigation' })
      .getByRole('link', { name: 'Pages' })
      .click();
    await page.locator('#content-table tbody th a').first().click();
    await setTextSize(page, '200%');
    await layoutGate(page, 'editor');
    // The long key's revoke button (TODO #63), on API access since #101.
    await page.goto('/admin/probe/site?section=api');
    await setTextSize(page, '200%');
    await layoutGate(page, 'API access with a long key name');
  }

  test.describe('Dutch shell copy', () => {
    test.use({ locale: 'nl-NL', viewport: NARROW });
    test('keeps the active section and whole navigation labels at 200% text', async ({ page }) => {
      await login(page, '/admin/probe', email);
      await setTextSize(page, '200%');
      await checkShell(page, 'Probe', 'Dashboard');
      await layoutGate(page, 'dashboard with the menu open');
      await page
        .getByRole('navigation', { name: 'Sitenavigatie' })
        .getByRole('link', { name: 'Pagina’s' })
        .click();
      await checkShell(page, 'Probe', 'Pagina’s');
    });
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

    await page.getByRole('link', { name: 'Profile' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Profile and preferences' })
    ).toBeVisible();
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
    await page.getByRole('link', { name: 'Terug' }).click();
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
    await nl.locator('details', { hasText: 'Inplannen' }).locator('summary').click();
    await expect(nl.getByText('Tijd in Asia/Tokyo')).toBeAttached();
    await nl.getByLabel('Publiceren op').fill('2030-01-04T17:00');
    await nl.getByRole('button', { name: 'Inplannen', exact: true }).click();
    await expect(page).toHaveURL(`${edit}?done=schedule&locale=nl`);
    await expect(nl).toContainText('Ingepland voor 2030-01-04 17:00 (Asia/Tokyo)');

    // Back to the site's zone: the same instant, nine hours earlier on the clock, unnamed.
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
  const row = (page: Page, type: string) => page.locator('li.status-row', { hasText: type });
  const verdict = (page: Page) =>
    page.getByRole('region', { name: /aandacht|Alles loopt|onbekend/ });

  test('an administrator retries and closes a stuck task without JavaScript', async ({ page }) => {
    const run = `${test.info().project.name}-${Date.now()}`;
    const retried = `e2e.status.${run}.retry`;
    const closed = `e2e.status.${run}.close`;
    const ids = [await stuckJob(retried), await stuckJob(closed)];
    try {
      await login(page, '/admin/probe');
      await page.getByRole('link', { name: 'Status', exact: true }).click();
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
      await expect(page.getByRole('status')).toContainText('De taak draait opnieuw');
      await expect(row(page, retried)).toHaveCount(0);

      // Closing asks first, in the row; a disclosure, so it works without JS too.
      await row(page, closed).getByText('Afsluiten', { exact: true }).click();
      await expect(row(page, closed)).toContainText('De taak draait niet meer');
      await expectNoAxeViolations(page);
      await row(page, closed)
        .getByRole('button', { name: /Ja, sluit deze taak af/ })
        .click();
      await expect(page.getByRole('status')).toContainText('De taak is afgesloten.');
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
      await expect(log.first()).not.toContainText('Een lid');
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

      test('admin controls and UI gate at 320 CSS px and 200% text', async ({ page }) => {
        const f = await fixture();
        await login(page, '/admin/probe/connections');
        const card = page.locator('article', {
          has: page.getByRole('heading', { name: f.purpose }),
        });
        await expect(card).toBeVisible();
        const credential = card.locator('form[action="?/credential"]');
        await credential
          .getByLabel(locale.startsWith('nl') ? 'Nieuwe sleutel' : 'New signing secret')
          .fill('e2e-synthetic-secret');
        await credential.getByRole('button').click();
        await expect(card).not.toContainText('e2e-synthetic-secret');
        await card
          .getByRole('button', {
            name: locale.startsWith('nl') ? 'Aflevering hervatten' : 'Resume delivery',
          })
          .click();
        await card
          .getByRole('button', {
            name: locale.startsWith('nl') ? 'Proef versturen' : 'Send test',
          })
          .click();
        await expect(card).toContainText(
          locale.startsWith('nl') ? 'Proef, geen persoon gekopieerd' : 'Test, no person copied'
        );
        if (isA11y()) {
          await setTextSize(page, '200%');
          await layoutGate(page, 'connections', 'main');
          await expectNoAxeViolations(page);
        }
        // The unknown attempt offers only a manual close, never a retry. The synthetic test sent
        // above is a separate, pending attempt and may keep its own retry.
        const unknown = card.locator('.intent', {
          hasText: locale.startsWith('nl') ? 'Uitkomst onbekend' : 'Outcome unknown',
        });
        await expect(unknown).toContainText(
          locale.startsWith('nl') ? 'Mycel weet niet of de ontvanger' : 'Mycel cannot tell whether'
        );
        await expect(unknown.getByRole('button')).toHaveCount(1);
        await unknown
          .getByRole('button', {
            name: locale.startsWith('nl') ? 'Markeer als afgehandeld' : 'Mark as handled',
          })
          .click();
        await expect(card).toContainText(
          locale.startsWith('nl') ? 'Handmatig afgehandeld' : 'Handled by hand'
        );
        await card
          .getByRole('button', {
            name: locale.startsWith('nl') ? 'Aflevering pauzeren' : 'Pause delivery',
          })
          .click();
        await card
          .getByRole('button', {
            name: locale.startsWith('nl') ? 'Koppel los' : 'Disconnect',
            exact: true,
          })
          .click();
        await expect(
          page.getByRole('heading', {
            name: locale.startsWith('nl')
              ? 'Deze koppeling ontkoppelen?'
              : 'Disconnect this connection?',
          })
        ).toBeVisible();
        await page
          .getByRole('button', {
            name: locale.startsWith('nl') ? 'Ja, koppel los' : 'Confirm disconnect',
          })
          .click();
        await expect(card).toContainText(locale.startsWith('nl') ? 'Ontkoppeld' : 'Disconnected');
      });
    });
  }
});
