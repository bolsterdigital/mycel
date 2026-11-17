// Connecting a site's Mollie account for donations (brief MY-252 PR 3): one key under
// Connections, stored encrypted and switched on, never shown again; a refused key leaves nothing
// behind; the connection's page offers no delivery fields or test send, and disconnecting it
// offers the setup again. 320 CSS px and 200% text under axe. The e2e installation pays with the
// fake provider, so no request reaches Mollie. In the a11y project only: the probe site has one
// live Mollie connection at a time, and the setup is a native form either way.

import { expect, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { onlyA11y } from '../project';

const KEY = 'test_e2eSyntheticMollieKey000000000';

/** Runs in a test with a narrow Dutch page. */
export async function exerciseMollieConnection(page: Page): Promise<void> {
  onlyA11y();
  // A run that stopped halfway left its connection live; this one starts without.
  await withInvoker(async (invoker) => {
    const admin = systemPrincipal(await tenantId(), 'e2e');
    for (const c of (await invoker.run(useCases.listConnections, admin, {})).connections)
      if (c.provider === 'mollie' && c.state !== 'disconnected')
        await invoker.run(useCases.disconnectConnection, admin, {
          id: c.id,
          baseVersion: c.version,
        });
  });

  await login(page, '/admin/probe/connections');
  const main = page.locator('main');
  await main.getByText('Mollie koppelen voor giften').click();
  await setTextSize(page, '200%');
  await layoutGate(page, 'connections-mollie', 'main');
  await expectNoAxeViolations(page);
  await setTextSize(page, '100%');
  const setup = main.locator('form[action="?/mollie"]');
  await setup.getByLabel('Mollie-API-sleutel').fill('sk_not_a_mollie_key_000000000000');
  await setup.getByRole('button', { name: 'Mollie koppelen' }).click();
  await expect(main).toContainText('Controleer de koppelingsgegevens');
  // A refused key leaves nothing behind: the setup is still offered.

  await main.getByText('Mollie koppelen voor giften').click();
  await setup.getByLabel('Mollie-API-sleutel').fill(KEY);
  await setup.getByRole('button', { name: 'Mollie koppelen' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Donations' })).toBeVisible();
  await expect(main).toContainText('Mollie');
  await expect(main).toContainText('Er is een sleutel ingesteld');
  await expect(page.locator('body')).not.toContainText(KEY);
  await expect(main.getByRole('button', { name: 'Aflevering pauzeren' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Proef versturen' })).toHaveCount(0);
  await expect(main.locator('input[name="destination"]')).toHaveCount(0);
  await expect(main.getByLabel('Mollie-API-sleutel')).toBeVisible();
  await setTextSize(page, '200%');
  await layoutGate(page, 'connection-mollie', 'main');
  await expectNoAxeViolations(page);
  await setTextSize(page, '100%');

  await main.getByRole('button', { name: 'Koppel los', exact: true }).click();
  await page.getByRole('button', { name: 'Ja, koppel los' }).click();
  await expect(main).toContainText('Losgekoppeld');
  await page.goto('/admin/probe/connections');
  await expect(main.getByText('Mollie koppelen voor giften')).toBeVisible();
}
