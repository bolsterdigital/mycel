// Publication browser helpers wait for the native disclosure to become a modal before acting.
// Rejected: checking visibility, because the SSR fallback is visible before hydration closes it.
import { expect, test, type Page } from '@playwright/test';
import { isA11y } from './project';

export async function openPublication(page: Page) {
  if (!isA11y()) return;
  await expect(page.locator('.ui-publication-disclosure')).toHaveClass(/enhanced/);
  if (!(await page.locator('#publication-panel:modal').count()))
    await page.locator('a[href="#publication-panel"]').click();
  await expect(page.locator('#publication-panel:modal')).toBeVisible();
}

export async function closePublication(page: Page) {
  if (!isA11y()) return;
  // A refused publish reopens the drawer on mount. Counting before that closes nothing, and the
  // modal then makes the form inert, so the next fill types nowhere (seen under full-suite load).
  await expect(page.locator('.ui-publication-disclosure')).toHaveClass(/enhanced/);
  if (await page.locator('#publication-panel:modal').count()) {
    await page.keyboard.press('Escape');
    await expect(page.locator('#publication-panel')).toBeHidden();
  }
}

export async function exercisePublicationDrawer(page: Page, edit: string) {
  await expect(page.locator('.ui-publication-disclosure')).toHaveClass(/enhanced/);
  await page.screenshot({ path: test.info().outputPath('editor-wide.png'), fullPage: true });
  await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
  const opener = page.locator('a[href="#publication-panel"]');
  const drawer = page.locator('#publication-panel');
  const title = page.locator('[name="title.nl"]');
  await title.fill('Nog niet opgeslagen');
  const revision = await page.locator('[name="baseRevisionId"]').inputValue();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await opener.evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
  const scroll = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('Enter');
  await expect(page.locator('#publication-panel:modal')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('publication-wide.png') });
  expect(await drawer.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await expect(page).toHaveURL(edit);
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  await expect(title).toHaveValue('Nog niet opgeslagen');
  await expect(page.locator('[name="baseRevisionId"]')).toHaveValue(revision);
  await opener.click();
  await drawer.getByRole('button', { name: /sluiten|close/i }).click();
  await expect(drawer).toBeHidden();
  await expect(opener).toBeFocused();
  await expect(title).toHaveValue('Nog niet opgeslagen');
  // An explicit navigation preference wins on the next editor visit.
  await page.evaluate(() => localStorage.setItem('mycel.admin.nav', 'full'));
  await page.goto(edit);
  await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'full');
  await page.evaluate(() => localStorage.setItem('mycel.admin.nav', 'rail'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
}

/** Live, pinned to an older revision: all four actions of the nl card, plus the schedule. */
export async function fourActions(page: Page, locale: string) {
  const nl = locale.startsWith('nl');
  const card = page.locator('#publication-nl');
  await openPublication(page);
  await card.getByRole('button', { name: nl ? 'Publiceren' : 'Publish', exact: true }).click();
  await openPublication(page);
  await card
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: nl ? /^Inplannen$/ : /^Schedule$/ }) })
    .locator('summary')
    .click();
  await card.locator('input[type="datetime-local"]').fill('2030-01-04T09:00');
  await openPublication(page);
  await card.getByRole('button', { name: nl ? 'Inplannen' : 'Schedule', exact: true }).click();
  await closePublication(page);
  await page.locator('#title\\.nl').fill('Poort 2');
  await page.getByRole('button', { name: nl ? 'Opslaan' : 'Save' }).click();
  await expect(page).toHaveURL(/\?saved$/);
}

/** `newPage` in either admin language. */
export async function newPageIn(page: Page, locale: string, slug: string): Promise<string> {
  const nl = locale.startsWith('nl');
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel(nl ? 'Titel (nl)' : 'Title (nl)').fill('Poort');
  await page.getByRole('button', { name: nl ? 'Concept maken' : 'Create draft' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** Secondary destructive action stays folded until the operator asks for it. */
export async function takeOffline(page: Page, locale: string, label: string) {
  await openPublication(page);
  const card = page.locator(`#publication-${locale}`);
  await card
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: label }) })
    .locator('summary')
    .click();
  await card.getByRole('button', { name: label, exact: true }).click();
}
