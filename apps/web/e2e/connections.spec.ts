// Managed connection controls use native posts and the same registry as HTTP/MCP. The fixture's
// destination passes the configuration check through a fake DNS answer; the worker checks DNS
// again itself before any send. A seeded `unknown` intent proves the manual resolution path.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/admin/probe/connections');
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill('e2e-admin@probe.test');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/connections$/);
}

async function fixture() {
  const { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } =
    await import('@mycel/db');
  const { Invoker, buildRegistry, systemPrincipal, useCases, SYNTHETIC_SCOPE, SYNTHETIC_SOURCE } =
    await import('@mycel/core');
  const { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } =
    await import('@mycel/core/testing');
  const db = createDb(process.env['APP_DATABASE_URL']!);
  const operator = createDb(process.env['DATABASE_URL']!);
  const tenant = (await createTenantDirectory(operator).findBySlug('probe'))!;
  const uow = createUnitOfWork(db, {
    clock: { now: () => new Date() },
    ids: uuidv7Ids,
    signer: new FakeSigner(),
    inputHasher: new FakeInputHasher(),
    dns: new FakeDns({ 'hooks.example.org': ['8.8.8.8'] }),
    platform: memoryPlatform,
    connectionCredentialKey: process.env['CONNECTION_CREDENTIAL_KEY'],
  });
  const principal = systemPrincipal(tenant.id, 'e2e');
  const invoker = new Invoker(buildRegistry(), uow);
  const purpose = `Synthetic webhook ${test.info().project.name} ${Date.now()}`;
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
  return {
    purpose,
    id: connection.id,
    async close() {
      await db.destroy();
      await operator.destroy();
    },
  };
}

for (const locale of ['nl-NL', 'en-US']) {
  test.describe(`managed connections ${locale}`, () => {
    test.use({
      viewport: { width: 320, height: 900 },
      locale,
      extraHTTPHeaders: {
        'x-forwarded-proto': 'http',
        'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
      },
    });

    test('admin controls and UI gate at 320 CSS px and 200% text', async ({ page }) => {
      const f = await fixture();
      try {
        await login(page);
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
          await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
          const problems = await page.evaluate(() => {
            const width = document.documentElement.clientWidth;
            const errors: string[] = [];
            if (document.documentElement.scrollWidth > width)
              errors.push(`horizontal scroll ${document.documentElement.scrollWidth} > ${width}`);
            for (const button of document.querySelectorAll('main button, main a.button')) {
              const bounds = button.getBoundingClientRect();
              if (button.scrollWidth > button.clientWidth + 1)
                errors.push(`clipped: ${button.textContent}`);
              if (bounds.right > width + 1 || bounds.left < -1)
                errors.push(`outside: ${button.textContent}`);
              if (bounds.width < 44 || bounds.height < 44)
                errors.push(`target: ${button.textContent}`);
              const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                for (const match of (node.textContent ?? '').matchAll(/\S+/g)) {
                  const range = document.createRange();
                  range.setStart(node, match.index);
                  range.setEnd(node, match.index + match[0].length);
                  if (range.getClientRects().length > 1)
                    errors.push(`word broken: ${match[0]} in ${button.textContent}`);
                }
              }
            }
            return errors;
          });
          await card.screenshot({
            path: test.info().outputPath(`connections-320-200-${locale}.png`),
          });
          expect(problems).toEqual([]);
          const { violations } = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
            .analyze();
          expect(violations.map((v) => v.id)).toEqual([]);
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
      } finally {
        await f.close();
      }
    });
  });
}
