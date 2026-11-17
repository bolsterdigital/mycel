// A one-off gift over HTTP (brief MY-252 PR 2), against the fake payment provider the e2e runner
// starts the fronts with (`PAYMENT_PROVIDER=fake`): a visitor picks an amount on a published page
// with a donation form, passes the hop page to the provider's screen, chooses an outcome and
// lands on the return page that shows it; a second visitor types an amount of their own and
// fails. The administrator then finds both under Donations, and the paid one on the donor's own
// page. Works the same in the no-js project: the hop is a meta refresh, not a script. The core
// record is `packages/core/src/money/donation-form.test.ts`; the fixtures are made here.

import { expect, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { pastMinimumFillTime } from '../form';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { forwarded, login } from '../login';
import { isA11y } from '../project';

/** A published page in Dutch with a fresh donation form on it; returns its slug. */
async function donationPage(project: string): Promise<string> {
  const slug = `doneer-${project}-${Date.now()}`;
  const editor = systemPrincipal(await tenantId(), 'e2e-donation');
  await withInvoker(async (invoker) => {
    const form = await invoker.run(useCases.createForm, editor, { kind: 'donation' });
    const created = await invoker.run(useCases.createItem, editor, {
      slug,
      document: {
        type: 'page',
        title: { nl: 'Steun ons' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [{ type: 'form', version: 1, props: { formId: form.id } }],
      },
    });
    await invoker.run(useCases.publishItem, editor, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale: 'nl',
    });
  });
  return slug;
}

/** Give on the page, end at the provider's screen with `outcome`, and land on the return page. */
async function give(
  page: Page,
  slug: string,
  email: string,
  amount: { preset: RegExp } | { own: string },
  outcome: 'Betaald' | 'Mislukt'
) {
  // A client address of its own: the spec's other posts share the file's one, and a post
  // without JavaScript has a small hourly bucket per address (`forms/spam.ts`).
  await page.context().setExtraHTTPHeaders(forwarded());
  await page.goto(`/probe/${slug}`);
  if ('preset' in amount) await page.getByRole('radio', { name: amount.preset }).check();
  else await page.getByLabel('Ander bedrag (€)').fill(amount.own);
  await page.getByLabel('E-mailadres').fill(email);
  await pastMinimumFillTime(page);
  await page.getByRole('button', { name: 'Doneer' }).click();
  await expect(page).toHaveURL(/\/_pay\/fake_[0-9a-f-]+$/);
  await expect(page.getByRole('heading', { name: 'Testbetaling' })).toBeVisible();
  if (isA11y()) await expectNoAxeViolations(page, { label: 'fake payment screen' });
  await page.getByRole('button', { name: outcome }).click();
  await expect(page).toHaveURL(/\/donation\/[^/?]+\?back=/);
}

export async function exerciseDonation(page: Page, project: string): Promise<void> {
  const slug = await donationPage(project);
  const stamp = `${project}-${Date.now()}`;
  const paid = `gever-${stamp}@example.org`;
  const failed = `twijfel-${stamp}@example.org`;

  await page.goto(`/probe/${slug}`);
  const presets = page.getByRole('group', { name: 'Bedrag' });
  await expect(presets.getByRole('radio')).toHaveCount(3);
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'donation form' });
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'donation form at 320px / 200%', 'main');
    await setTextSize(page, '16px');
  }

  await give(page, slug, paid, { preset: /25/ }, 'Betaald');
  await expect(page.getByRole('heading', { name: 'Dank je wel voor je gift' })).toBeVisible();
  await expect(page.getByText(/Bedrag: €\s?25$/)).toBeVisible();
  if (isA11y()) await expectNoAxeViolations(page, { label: 'donation thanks' });
  await expect(page.getByRole('link', { name: 'Terug naar de pagina' })).toHaveAttribute(
    'href',
    `/${slug}`
  );

  await give(page, slug, failed, { own: '12.50' }, 'Mislukt');
  await expect(page.getByRole('heading', { name: 'Je gift is niet gelukt' })).toBeVisible();
  await expect(page.getByText(/Bedrag: €\s?12,50$/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Probeer opnieuw' })).toHaveAttribute(
    'href',
    `/${slug}`
  );

  await login(page, '/admin/probe/donations');
  const row = (email: string) => page.getByRole('row').filter({ hasText: email });
  await expect(row(paid)).toContainText(/€\s?25/);
  await expect(row(paid)).toContainText('Betaald');
  await expect(row(failed)).toContainText(/€\s?12,50/);
  await expect(row(failed)).toContainText('Mislukt');
  await page.goto('/admin/probe/donations?status=failed');
  await expect(row(failed)).toBeVisible();
  await expect(row(paid)).toHaveCount(0);
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'donations list' });
    await page.setViewportSize(NARROW);
    await layoutGate(page, 'donations list at 320px', 'main');
  }
  await page.goto('/admin/probe/donations');
  await row(paid).getByRole('link', { name: paid }).click();
  await expect(page.getByRole('heading', { name: paid })).toBeVisible();
  await expect(page.getByText(/Gaf €\s?25/)).toBeVisible();
}
