// Welcome mails in the admin (MY-258 PR 2), in both projects: the overview lists the series, the
// form sets two steps, switching it on asks once more and names the list, a second post saves,
// and "Send test to me" puts both steps in the console mailer's spool for the admin, marked as a
// test. Its own list (`welkom-e2e-<project>-<time>`), which no signup test subscribes to, so a series
// switched on here sends nobody else anything. Who starts a series, when steps go and what stops
// them are core records (`mailing/automation.test.ts`); the tables' RLS is `mail-automations.test.ts`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { ADMIN, login } from '../login';
import { isA11y } from '../project';
import { tenantId, withInvoker } from '../invoker';

/** Two published public pages, made once per project. */
async function pages(project: string): Promise<{ title: string; id: string }[]> {
  const system = systemPrincipal(await tenantId(), 'e2e');
  return withInvoker(async (invoker) => {
    const made = [];
    for (const name of ['welkom', 'tips']) {
      const slug = `${name}-${project}-${Date.now().toString(36)}`;
      const title = `Welkomstmail ${name} ${project}`;
      const { item, revision } = await invoker.run(useCases.createItem, system, {
        slug,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          lead: { nl: 'Fijn dat je erbij bent.' },
          access: { level: 'public' },
          blocks: [],
        },
      });
      await invoker.run(useCases.publishItem, system, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
      made.push({ title, id: item.id });
    }
    return made;
  });
}

/** The spooled mails to `to` whose subject is `subject`. */
const spooled = (to: string, subject: string) => {
  const dir = process.env['MAIL_SPOOL_DIR'];
  if (!dir) throw new Error('MAIL_SPOOL_DIR is not set; run through scripts/e2e/e2e.mjs');
  return readdirSync(dir)
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .filter((m) => m.to.email === to && m.subject === subject);
};

export async function exerciseWelcomeMails(page: Page, project: string) {
  // A fresh list per run, so a retry on the same database starts without a series.
  const list = `welkom-e2e-${project}-${Date.now().toString(36)}`;
  const [welcome, tips] = await pages(project);
  const url = `/admin/probe/welcome-mails/${list}`;
  await login(page, url, ADMIN, { 'accept-language': 'nl' });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Welkomstmails voor ${list}`);

  // Two steps: the tips page after three days in the first row, the welcome page at once in the
  // fifth; core keeps them in order of delay.
  await page.getByLabel('Pagina of artikel').first().selectOption(tips!.id);
  await page.locator('#step-0-days').fill('3');
  await page.locator('#step-4-item').selectOption(welcome!.id);
  await page.locator('#step-4-days').fill('0');
  await page.getByLabel('Deze reeks naar nieuwe inschrijvers sturen').check();
  await page.getByRole('button', { name: 'Opslaan' }).click();

  // Switching on asks once more, naming the list; nothing is saved yet.
  await expect(page.getByText(`iedereen die zich voor ${list} bevestigt`)).toBeVisible();
  await expect(page.locator('#step-4-item')).toHaveValue(welcome!.id);
  await page.getByRole('button', { name: 'Welkomstmails aanzetten' }).click();
  await expect(page.getByText('Welkomstmails opgeslagen.')).toBeVisible();
  await expect(page.locator('#step-0-item')).toHaveValue(welcome!.id);
  await expect(page.locator('#step-1-item')).toHaveValue(tips!.id);
  await expect(page.locator('#step-1-days')).toHaveValue('3');
  await expect(page.locator('#step-2-item')).toHaveValue('');
  await expect(page.getByLabel('Deze reeks naar nieuwe inschrijvers sturen')).toBeChecked();

  // A save that keeps it on asks nothing; two steps on one day are refused in words.
  await page.locator('#step-1-days').fill('0');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText('Twee stappen vallen op dezelfde dag.')).toBeVisible();
  await page.locator('#step-1-days').fill('3');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText('Welkomstmails opgeslagen.')).toBeVisible();

  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'welcome mails form' });
    await page.setViewportSize(NARROW);
    for (const size of ['200%', '16px']) {
      await setTextSize(page, size);
      await layoutGate(page, `welcome mails at ${size}`, 'main');
    }
  }

  // The test: both steps to the admin, marked as a test.
  await page.getByRole('button', { name: 'Test naar mij sturen' }).click();
  await expect(page.getByText('Test verstuurd: 2 mails')).toBeVisible();
  for (const { title } of [welcome!, tips!])
    await expect
      .poll(() => spooled(ADMIN, `[Test] ${title}`).length, { timeout: 15_000, message: title })
      .toBe(1);

  // The overview lists the series as on, with its two steps.
  await page.goto('/admin/probe/welcome-mails');
  const row = page.getByRole('row').filter({ hasText: list });
  await expect(row).toContainText('Aan');
  await expect(row.getByRole('cell').nth(1)).toHaveText('2');

  // Switching it off asks nothing.
  await page.goto(url);
  await page.getByLabel('Deze reeks naar nieuwe inschrijvers sturen').uncheck();
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page.getByText('Welkomstmails opgeslagen.')).toBeVisible();
}
