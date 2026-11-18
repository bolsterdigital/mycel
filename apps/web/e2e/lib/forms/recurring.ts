// Giving monthly (MY-254 PR 2), against the fake payment provider of the e2e runner: a donation
// form that offers once and monthly, a visitor who chooses monthly and pays the first payment,
// the return page that says how often from now on, the gift under Donations → Recurring with its
// own page, the giver's page that says "Geeft € 10 per maand", and "Stop" from the gift's page.
// Charges by mandate are the worker's (`subscriptions.charge`), proven in
// `packages/api/src/subscriptions-job.test.ts`; this spec covers what a person sees.

import { expect, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';
import { give } from './donation';

/** A published page with a donation form whose amount offers once and monthly. */
async function monthlyPage(project: string): Promise<string> {
  const slug = `maandelijks-${project}-${Date.now()}`;
  const editor = systemPrincipal(await tenantId(), 'e2e-recurring');
  await withInvoker(async (invoker) => {
    const form = await invoker.run(useCases.createForm, editor, { kind: 'donation' });
    const { version } = await invoker.run(useCases.getForm, editor, { id: form.id });
    await invoker.run(useCases.updateForm, editor, {
      baseVersion: version,
      value: {
        ...form,
        fields: form.fields.map((f) =>
          f.type === 'amount' ? { ...f, intervals: ['once' as const, 'month' as const] } : f
        ),
      },
    });
    const created = await invoker.run(useCases.createItem, editor, {
      slug,
      document: {
        type: 'page',
        title: { nl: 'Geef maandelijks' },
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

export async function exerciseRecurring(page: Page, project: string): Promise<void> {
  const slug = await monthlyPage(project);
  const giver = `maandelijks-${project}-${Date.now()}@example.org`;

  await page.goto(`/probe/${slug}`);
  const often = page.getByRole('group', { name: 'Hoe vaak?' });
  await expect(often.getByRole('radio', { name: 'Eenmalig' })).toBeChecked();
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'monthly donation form' });
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'monthly donation form at 320px / 200%', 'main');
    await setTextSize(page, '16px');
  }

  await give(page, slug, giver, { preset: /10/, interval: 'Maandelijks' }, 'Betaald');
  await expect(page.getByRole('heading', { name: 'Dank je wel voor je gift' })).toBeVisible();
  await expect(page.getByText(/Je geeft voortaan €\s?10 per maand\./)).toBeVisible();

  await login(page, '/admin/probe/donations/recurring');
  const row = page.getByRole('row').filter({ hasText: giver });
  await expect(row).toContainText(/€\s?10 per maand/);
  await expect(row).toContainText('Loopt');
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'recurring list' });
    await page.setViewportSize(NARROW);
    await layoutGate(page, 'recurring list at 320px', 'main');
  }

  await row.getByRole('link', { name: giver }).click();
  await expect(page.getByRole('heading', { name: giver })).toBeVisible();
  await expect(page.getByRole('link', { name: /Geeft €\s?10 per maand/ })).toBeVisible();
  await expect(page.getByText(/Begon €\s?10 per maand te geven/)).toBeVisible();

  await page.getByRole('link', { name: /Geeft €\s?10 per maand/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: /€\s?10 per maand/ })).toBeVisible();
  await expect(
    page
      .getByRole('table', { name: 'Betalingen' })
      .getByRole('row')
      .filter({ hasText: 'Eerste betaling' })
  ).toContainText('Betaald');
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'recurring gift' });
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'recurring gift at 320px / 200%', 'main');
    await setTextSize(page, '16px');
  }
  await page.getByRole('button', { name: 'Stoppen' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stoppen' }).click();
  await expect(
    page.getByText('De gift is gestopt. Er wordt niets meer geïncasseerd.')
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stoppen' })).toHaveCount(0);
  await expect(page.getByText('Gestopt').first()).toBeVisible();
}
