// Managed connection controls use native posts and the same registry as HTTP/MCP. The fixture's
// destination passes the configuration check through a fake DNS answer; the worker checks DNS
// again itself before any send. A seeded `unknown` intent proves the manual resolution path.
import { SYNTHETIC_SCOPE, SYNTHETIC_SOURCE, systemPrincipal, useCases } from '@mycel/core';
import { FakeDns } from '@mycel/core/testing';
import { uuidv7Ids } from '@mycel/db';
import { expect, test } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { tenantId, withInvoker } from './lib/invoker';
import { login } from './lib/login';

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
