// The launch checklist in the admin (MY-262 PR 2), in both projects: the verdict and the phases
// render, a step is ticked with a note through its phase's Save, switched off and back on behind
// "Aanpassen", and a step someone else saved after the page was read stays as they saved it. Each
// project works on its own step of the shared `probe` site (`backup` and `content-freeze`), so the
// two never meet. What the checks find and what the verdict counts are core records
// (`launch/launch.test.ts`); RLS and the export are `db/src/launch/launch.test.ts`. The layout
// gate at 320 CSS px and 200% text is the generic one (routes.ts).
import { expect, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { ADMIN, login } from '../login';
import { isA11y } from '../project';
import { tenantId, withInvoker } from '../invoker';

const URL = '/admin/probe/livegang';

export async function exerciseLaunchChecklist(page: Page, project: string) {
  const id = project === 'a11y' ? 'content-freeze' : 'backup';
  const row = page.locator(`#step-${id}`);
  const save = page.getByRole('button', { name: 'Opslaan: Voorbereiding' });
  await login(page, URL, ADMIN, { 'accept-language': 'nl' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Livegang');
  await expect(page.locator('#verdict-title')).toHaveText(/Nog \d+ stappen? vóór de livegang open/);
  await expect(page.getByRole('heading', { level: 2, name: 'Voorbereiding' })).toBeVisible();
  if (isA11y()) await expectNoAxeViolations(page, { label: 'launch checklist' });

  // Tick it with a note; a fresh note per run, so a rerun on the same database still saves.
  const note = `Gedaan door e2e ${project} ${Date.now().toString(36)}`;
  await page.locator(`#tick-${id}`).check();
  await row
    .locator('summary')
    .filter({ hasText: /^(Notitie of aanpassen|Aanpassen)$/ })
    .click();
  await page.locator(`#note-${id}`).fill(note);
  await save.click();
  await expect(page.getByText('1 stap opgeslagen.')).toBeVisible();
  await expect(page.locator(`#tick-${id}`)).toBeChecked();
  await expect(row).toContainText(`Notitie: ${note}`);
  await expect(row.locator('.ui-badges')).toContainText('Gedaan');

  // Switched off it folds away at the bottom of its phase; back to the default it returns.
  await row.getByText('Aanpassen', { exact: true }).click();
  await page.locator(`#applicable-${id}`).selectOption('off');
  await save.click();
  await expect(page.getByText('1 stap opgeslagen.')).toBeVisible();
  await expect(row.locator('.ui-badges')).toContainText('Niet van toepassing');
  await expect(
    page.locator(`#phase-prepare details.ui-fold:has(#step-${id}) > summary`)
  ).toHaveText(/niet van toepassing/);
  await page.locator(`#phase-prepare details.ui-fold:has(#step-${id}) > summary`).click();
  await row.getByText('Aanpassen', { exact: true }).click();
  await page.locator(`#applicable-${id}`).selectOption('');
  await save.click();
  await expect(page.getByText('1 stap opgeslagen.')).toBeVisible();
  await expect(row.locator('.ui-badges')).toContainText('Gedaan');

  // Someone else saves this step after the page was read: Save leaves their note standing.
  const theirs = `Door een collega ${Date.now().toString(36)}`;
  await row.getByText('Aanpassen', { exact: true }).click();
  await page.locator(`#note-${id}`).fill('Mijn versie');
  const system = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker((invoker) =>
    invoker.run(useCases.updateLaunchStep, system, { stepId: id, note: theirs })
  );
  await save.click();
  await expect(page.getByText('intussen door iemand anders gewijzigd')).toBeVisible();
  await expect(row).toContainText(`Notitie: ${theirs}`);
}
