// flow: access
// Who may administer a site, and what the admin shows them: sign-in, membership, API keys, the
// tenant shell across sites, the status page and managed connections. Each part below was a spec
// of its own until TODO #50 folded the suite to its budget (testing.md § End-to-end flows); each
// keeps its own fixtures in its own describe.

import {
  Invoker,
  SYNTHETIC_SCOPE,
  SYNTHETIC_SOURCE,
  UseCaseError,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { FakeDns } from '@mycel/core/testing';
import { type Database, upsertTenant, uuidv7Ids } from '@mycel/db';
import { type Page, expect, test } from '@playwright/test';
import type { Kysely } from 'kysely';
import { expectNoAxeViolations } from './lib/axe';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { ADMIN, login } from './lib/login';

// Operator admin (TODO #7), the seed of the "publish" flow in testing.md: login through the mock
// IdP as e2e-admin@probe.test (scripts/e2e.mjs seeds that admin and starts the IdP), access by
// membership, and an API key made in the admin that works over HTTP until it is revoked there.
// Runs without JavaScript and under axe like the signup spec. The overview with members, domains
// and keys is a route of the generic UI gate (routes.ts).
test.describe('admin', () => {
  test.use({
    locale: 'nl-NL',
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
  });

  const api = (path: string, token: string) =>
    fetch(`${process.env['E2E_API_URL']}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

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
  test('the admin sends its own headers and may not be framed at all', async ({
    page,
    request,
  }) => {
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
});

// The tenant shell is one navigation surface across routes, locales and site memberships.
// A second, empty site catches stale site names and links when changing tenants.
test.describe('admin-shell', () => {
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
      // The content editor's live preview and the media upload's thumbnails are optional modules,
      // inert in this project; the native flows remain the no-JS contract. Other shell routes
      // still emit no script.
      const path = new URL(page.url()).pathname;
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
    await checkShell(page, 'Probe', 'Overview');
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
      .getByRole('link', { name: 'Pages' })
      .click();
    await expect(page.locator('#content-table tbody tr')).toHaveCount(0);
    await checkShell(page, 'Second editorial site', 'Pages');
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
      .getByRole('link', { name: 'Pages' })
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
        .getByRole('link', { name: 'Pagina’s' })
        .click();
      await checkShell(page, 'Probe', 'Pagina’s');
    });
  });
});

// Status page (TODO #17c): a tenant administrator sees a stuck task of the site, tries it again,
// closes another after confirming, and reads a diagnosis without an address in it. Runs without
// JavaScript and under axe like the other admin specs; the UI gate (skill ui-action-layout) checks
// both action groups (a task's two buttons, the close confirmation) at 320 CSS px and 200% text.
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
    const { sql } = await import('kysely');
    const db = createDb(process.env['DATABASE_URL']!);
    try {
      const probe = await createTenantDirectory(db).findBySlug('probe');
      await db.transaction().execute(async (trx) => {
        await sql`set local role mycel_worker`.execute(trx);
        await fn(trx, probe!.id);
      });
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

  const card = (page: Page, type: string) =>
    page.locator('article', { has: page.getByRole('heading', { level: 3, name: type }) });

  test('an administrator retries and closes a stuck task without JavaScript', async ({ page }) => {
    const run = `${test.info().project.name}-${Date.now()}`;
    const retried = `e2e.status.${run}.retry`;
    const closed = `e2e.status.${run}.close`;
    const ids = [await stuckJob(retried), await stuckJob(closed)];
    try {
      await login(page, '/admin/probe');
      await page.getByRole('link', { name: 'Status en vastgelopen werk' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Status' })).toBeVisible();
      await expect(card(page, retried)).toContainText('10 van 10');
      await expect(card(page, retried)).toContainText('delivery failed for [email]');
      await expect(page.locator('main')).not.toContainText('e2e-payload');
      await expectNoAxeViolations(page);

      // The diagnosis is on the page, redacted, before anyone shares it.
      const diagnosis = page.locator('pre.diagnosis');
      await expect(diagnosis).toContainText('site: probe');
      await expect(diagnosis).toContainText(`- ${retried} `);
      await expect(diagnosis).not.toContainText('@');
      await expect(page.getByLabel('Diagnose, om te selecteren en kopiëren')).toHaveValue(
        /site: probe/
      );

      await card(page, retried).getByRole('button', { name: 'Opnieuw proberen' }).click();
      await expect(page.getByRole('status')).toContainText('De taak draait opnieuw');
      await expect(card(page, retried)).toHaveCount(0);

      // Closing asks first; the confirmation is a form of its own, so it works without JS too.
      await card(page, closed).getByRole('button', { name: 'Afsluiten' }).click();
      await expect(page.getByRole('heading', { name: `${closed} afsluiten?` })).toBeVisible();
      await expect(card(page, closed)).toBeVisible();
      await expectNoAxeViolations(page);
      await page.getByRole('button', { name: 'Ja, sluit deze taak af' }).click();
      await expect(page.getByRole('status')).toContainText('De taak is afgesloten.');
      await expect(card(page, closed)).toHaveCount(0);

      // Both recoveries are in the latest actions.
      const actions = page.getByRole('region', { name: 'Laatste acties' });
      await expect(actions).toContainText('ops.job.close');
      await expect(actions).toContainText('ops.job.retry');
    } finally {
      await finish(ids);
    }
  });

  test.describe('UI gate: the status action groups at 320 CSS px and 200% text', () => {
    test.use({ viewport: NARROW });

    for (const text of TEXT_SIZES) {
      test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
        test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
        const type = `e2e.status.gate.${text.replace('%', '')}.${Date.now()}`;
        const id = await stuckJob(type);
        try {
          await login(page, '/admin/probe/status');
          const measure = async (name: string) => {
            await setTextSize(page, text);
            await layoutGate(page, name, 'main');
          };
          await measure('job');
          await card(page, type).getByRole('button', { name: 'Afsluiten' }).click();
          await measure('confirm');
          await page.getByRole('link', { name: 'Laten staan' }).click();
          await expect(card(page, type)).toBeVisible();
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
        if (test.info().project.name === 'a11y') {
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
