// One editorial task crosses profile, group and article forms, with the ordinary registry as
// read-back. Rejected: a browser test per label, which duplicates catalog and schema checks.
import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { useCases, systemPrincipal } from '@mycel/core';
import { callApi } from '../api';
import { login } from '../login';
import { tenantId, withInvoker } from '../invoker';
import { editorReady, reloadsEditor } from '../editor';
import { expectNoAxeViolations } from '../axe';
import { isA11y } from '../project';
import { NARROW, layoutGate, setTextSize } from '../layout';

async function measure(page: Page, label: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, label, 'main');
  await page.screenshot({ path: test.info().outputPath(`${label}-320-200.png`), fullPage: true });
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function exercisePeople(page: Page, request: APIRequestContext) {
  const unique = randomUUID().slice(0, 8);
  const name = `Person ${unique}`;
  const base = '/admin/probe/people';
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await login(page, `${base}/new`, undefined, { 'accept-language': 'en' });
  await page.locator('#person-name').fill(name);
  await page.locator('#person-role').fill('Editor');
  await page.locator('#person-bio').fill('Biography');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/people\/[^/]+\?saved=1$/);
  const personId = new URL(page.url()).pathname.split('/').pop()!;
  await measure(page, 'person-form');
  await withInvoker(async (invoker) => {
    const person = await invoker.run(useCases.getPerson, principal, { personId });
    const { id: _id, slug: _slug, createdAt: _created, updatedAt, ...fields } = person;
    await invoker.run(useCases.updatePerson, principal, {
      ...fields,
      personId,
      baseUpdatedAt: updatedAt,
      name: 'Changed elsewhere',
    });
  });
  await page.locator('#person-name').fill(`${name} mine`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('#person-name')).toHaveValue(`${name} mine`);
  // Reload deliberately before overwriting; an error must not refresh the original timestamp.
  await page.goto(`${base}/${personId}`);
  await page.locator('#person-name').fill(name);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.goto(`${base}/groups/new`);
  await page.locator('#group-name').fill(`Team ${unique}`);
  await page.locator(`#member-${personId}`).check();
  await page.locator(`#position-${personId}`).fill('1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/groups\/[^/]+\?saved=1$/);
  const groupId = new URL(page.url()).pathname.split('/').pop()!;
  await measure(page, 'group-form');
  await page.goto(`${base}?q=${unique}&group=${groupId}`);
  await expect(page.locator('#people tbody')).toContainText(name);
  await measure(page, 'people-list');
  const { item } = await callApi(request, 'content.item.create', {
    slug: `people-${unique}`,
    document: {
      type: 'article',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Author selection' },
      blocks: [],
    },
  });
  const itemId = item.id;
  await page.goto(`/admin/probe/content/${itemId}`);
  await editorReady(page);
  await page.locator('[name="title.nl"]').fill('Unsaved title stays');
  const fold = page.locator('#authors details');
  await fold.locator('summary').click();
  const added = `Author ${unique}`;
  await page.locator('#new-author-name').fill(added);
  await measure(page, 'author-picker');
  await page.getByRole('button', { name: 'Add and select author' }).click();
  await expect(page.locator('#authors')).toContainText(added);
  await expect(page.locator('#authors input:checked')).toHaveCount(1);
  await expect(page.locator('[name="title.nl"]')).toHaveValue('Unsaved title stays');
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  await withInvoker(async (invoker) => {
    const item = await invoker.run(useCases.getItem, principal, { itemId });
    expect(item.revision.document.type).toBe('article');
    if (item.revision.document.type !== 'article') throw new Error('article expected');
    const author = await invoker.run(useCases.getPerson, principal, {
      personId: item.revision.document.authorIds[0]!,
    });
    expect(author.name).toBe(added);
    expect(item.revision.document.title.nl).toBe('Unsaved title stays');
  });
}
