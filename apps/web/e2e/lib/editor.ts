// What the edit-screen specs share: making a page through the "new" form, reaching a block card,
// saving, and waiting until the screen's scripts have run. `newPage` and the block helpers used to
// be copied per describe, which is how the block cards ended up in the wrong spec.
// Rejected: a page object for the whole screen, because the specs mostly use the page itself and
// these few steps are the only ones they repeat.

import { type Locator, type Page, expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { isA11y } from './project';

/**
 * With JavaScript: everything that moves or changes the screen after hydration has run. Three
 * separate signals, because `tabs.js`, `edit-screen.js` and the block chooser start independently;
 * a late `tabs.js` still moved the choices 26 px after the other two. Without
 * JavaScript the document is final. Only for the edit screen of someone who may write.
 */
export async function editorReady(page: Page): Promise<void> {
  if (!isA11y()) return;
  await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
  await expect(page.locator('form#item-edit .ui-tabs:not([data-tabs])')).toHaveCount(0);
  await expect(page.locator('[data-block-picker]:not([data-picker-ready])')).toHaveCount(0);
}

/**
 * Run `submit`, which posts the edit form natively, and wait until the next edit screen is ready.
 * Without the mark, `editorReady` right after the click still sees the old document, which is
 * ready, and the next fill or click lands in a page that is about to go or is not hydrated yet
 * (a duplicate test once typed into a title that still held its old value).
 * Rejected: waiting for a URL, because a refused save comes back on the same address.
 */
export async function reloadsEditor(page: Page, submit: () => Promise<void>): Promise<void> {
  if (!isA11y()) return submit();
  await page.evaluate(() => {
    document.documentElement.dataset.e2eLeaving = '';
  });
  await submit();
  await expect(page.locator('html[data-e2e-leaving]')).toHaveCount(0);
  await editorReady(page);
}

/** Make a page in nl and en through the "new" form; returns its edit URL. */
export async function newPage(page: Page, slug: string, title: string, en = `${title} (en)`) {
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Titel (nl)').fill(title);
  await page.getByLabel('Titel (en)').fill(en);
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  // The first click on the new edit screen must not come before its scripts.
  await editorReady(page);
  return new URL(page.url()).pathname;
}

/** A page of its own for one block test; returns its edit URL. */
export function blockPage(page: Page, what: string): Promise<string> {
  const slug = `b-${what}-${test.info().project.name}-${randomUUID()}`;
  return newPage(page, slug, 'Blokkenproef', 'Block test');
}

/** The card of block `n` (1-based): its head holds the block's actions (#66 PR 3). */
export const card = (page: Page, n: number): Locator =>
  page.locator('section.ui-block-card').nth(n - 1);

/** Block `n` (1-based) of the edit page, opened, with its Display and Source folds open. */
export async function block(page: Page, n: number): Promise<Locator> {
  const details = card(page, n).locator('details.block');
  if ((await details.getAttribute('open')) === null)
    await details.locator(':scope > summary').click();
  const closed = details.locator('details.ui-block-group:not([open])');
  while ((await closed.count()) > 0) await closed.first().locator(':scope > summary').click();
  return details;
}

/** Opens "More actions" of block `n` (MY-110 A) and returns its card. */
export async function more(page: Page, n: number): Promise<Locator> {
  const menu = card(page, n).locator('details.ui-block-card-more');
  if ((await menu.getAttribute('open')) === null) await menu.locator(':scope > summary').click();
  return card(page, n);
}

/**
 * Save the one edit form after editing block `n` (#66 PR 2: one form, one save). Through
 * `reloadsEditor`: after an earlier save the old screen already has `?saved` and the status, so
 * those two alone pass before the new screen is there.
 */
export async function save(page: Page, n: number): Promise<void> {
  await block(page, n);
  await reloadsEditor(page, () =>
    page.getByRole('button', { name: 'Opslaan', exact: true }).click()
  );
  await expect(page).toHaveURL(/\?saved/);
  await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
}

/**
 * Point button `n` (0-based) inside `scope` at an address: with JavaScript through the target's
 * search, which takes an address on leaving the field; without, the select plus address field.
 */
export async function linkTo(scope: Locator, n: number, url: string): Promise<void> {
  const target = scope.getByRole('combobox', { name: 'Linkt naar' }).nth(n);
  if (isA11y()) {
    await target.fill(url);
    await target.press('Tab');
    await expect(target).toHaveValue(url);
    return;
  }
  await target.selectOption({ label: 'Het adres hieronder' });
  await scope.getByLabel('Adres (URL)').nth(n).fill(url);
}
