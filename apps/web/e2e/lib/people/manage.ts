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
  // MY-265: without a published article the site has no page, so no link; with "always" it has.
  const view = page.getByRole('link', { name: 'View on the site' });
  await expect(view).toHaveCount(0);
  const slug = await withInvoker(async (invoker) => {
    const {
      id: _id,
      slug,
      createdAt: _c,
      updatedAt,
      ...rest
    } = await invoker.run(useCases.getPerson, principal, { personId });
    await invoker.run(useCases.updatePerson, principal, {
      ...rest,
      personId,
      baseUpdatedAt: updatedAt,
      pagePolicy: 'always',
    });
    return slug;
  });
  await page.goto(`${base}/${personId}`);
  await expect(view).toHaveAttribute('href', new RegExp(`(/en)?/people/${slug}$`));
  await expect(view).toHaveAttribute('target', '_blank');
  await measure(page, 'person-form-view');
  await page.goto(`${base}/groups/new`);
  await page.locator('#group-name').fill(`Team ${unique}`);
  await page.locator(`#member-${personId}`).check();
  await page.locator(`#position-${personId}`).fill('1');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/groups\/[^/]+\?saved=1$/);
  const groupId = new URL(page.url()).pathname.split('/').pop()!;
  await measure(page, 'group-form');
  // An organisation: its own create button, only its own fields, the kind filter.
  await page.goto(base);
  await page.getByRole('link', { name: 'Add organisation', exact: true }).click();
  await expect(page.locator('h1')).toHaveText('Add organisation');
  for (const absent of ['#person-role', '#person-organisation', '#person-phone', '#person-policy'])
    await expect(page.locator(absent)).toHaveCount(0);
  const organisation = `Organisation ${unique}`;
  await page.locator('#person-name').fill(organisation);
  await page.locator('#person-bio').fill('A partner of ours.');
  await page
    .locator('summary')
    .filter({ hasText: /^Links$/ })
    .click();
  await page.locator('#link-0').fill('https://example.org/partner');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page).toHaveURL(/\/people\/[^/]+\?saved=1$/);
  const organisationId = new URL(page.url()).pathname.split('/').pop()!;
  await withInvoker(async (invoker) => {
    expect(
      await invoker.run(useCases.getPerson, principal, { personId: organisationId })
    ).toMatchObject({
      kind: 'organisation',
      name: organisation,
      links: [{ url: 'https://example.org/partner', kind: 'website' }],
    });
  });
  await page.goto(`${base}?q=${unique}`);
  await page.locator('#people-kind').selectOption('organisation');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(page.locator('#people tbody')).toContainText(organisation);
  await expect(page.locator('#people tbody')).not.toContainText(name);
  await page.goto(`${base}?q=${unique}&group=${groupId}`);
  await expect(page.locator('#people tbody')).toContainText(name);
  // The action group (two create buttons and groups) at 320 px and 200% text, in measure().
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
  // An organisation is never an author, so the picker does not offer it.
  await expect(page.locator('#authors')).not.toContainText(organisation);
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
