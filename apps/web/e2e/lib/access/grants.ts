// An administrator gives a supporter access to a tier and takes it back, on the supporter's own
// page: two native dialogs with a plain form post, so both projects walk it, in the fixture
// administrator's language (English). The registry is
// the read-back for the grant itself; core (`supporters/access.test.ts`) proves the policy, the
// replacement of a standing grant and the refusals. Rejected: a test per field and per refusal
// here, which repeats those suites through a browser.
import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

export async function exerciseSupporterGrants(page: Page, supporterId: string, email: string) {
  const id = randomUUID().slice(0, 8);
  const name = `Friends ${id}`;
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const tier = await withInvoker((invoker) =>
    invoker.run(useCases.createAccessTier, principal, {
      slug: `vrienden-${id}`,
      name: { nl: `Vrienden ${id}`, en: name },
    })
  );
  const grants = async () =>
    (await withInvoker((invoker) => invoker.run(useCases.getSupporter, principal, { email })))
      .grants;
  const row = page.locator('#supporter-access-table tbody tr', { hasText: name });

  await page.setViewportSize(NARROW);
  await login(page, `/admin/probe/supporters/${supporterId}`);
  await page.getByRole('button', { name: 'Give access', exact: true }).click();
  const give = page.getByRole('dialog', { name: 'Give access to a tier' });
  await give.getByLabel('Access tier').selectOption({ label: name });
  await give.getByLabel('Given as').selectOption('gift');
  await give.getByLabel('Reason').fill('A gift from the editors');
  if (isA11y()) await expectNoAxeViolations(page, { label: 'give access dialog' });
  await give.getByRole('button', { name: 'Give access', exact: true }).click();
  await expect(page.getByText('Access given.')).toBeVisible();
  await expect(row).toContainText('Gift');
  await expect(row).toContainText('No end date');
  await expect(row.locator('.ui-badge')).toHaveText('Active');
  // Both projects use this supporter at once, each with a tier of its own.
  expect(await grants()).toContainEqual(expect.objectContaining({ tierId: tier.id, kind: 'gift' }));

  // Both triggers stand now: the action group at the narrowest width and the largest text.
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'supporter page with grant actions' });
    for (const text of TEXT_SIZES) {
      await setTextSize(page, text);
      await layoutGate(page, `supporter grant actions at ${text}`, '#supporter-access');
    }
    await page.screenshot({
      path: test.info().outputPath('supporter-grant-actions-320-text200.png'),
      fullPage: true,
    });
    await setTextSize(page, '100%');
  }

  await page.getByRole('button', { name: 'Take access back', exact: true }).click();
  const take = page.getByRole('dialog', { name: 'Take access back' });
  await take.getByLabel('Access tier').selectOption({ label: name });
  await take.getByLabel('Reason').fill('The campaign week is over');
  await take.getByRole('button', { name: 'Take access back', exact: true }).click();
  await expect(page.getByText('Access taken back.')).toBeVisible();
  await expect(row).toHaveCount(0);
  expect((await grants()).map((g) => g.tierId)).not.toContain(tier.id);
}
