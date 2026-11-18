// A restricted item says what visitors get before any publish button, and a teaser beside the
// paywall is refused at the teaser choice (moved out of content-admin.spec.ts, which is at its
// size budget, when MY-254 PR 4 made the second axe check independent of the tier count).

import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { callApi, requireApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { newPage } from '../editor';
import { login } from '../login';
import { closePublication, openPublication } from '../publication';

const card = (page: Page, locale: string) => page.locator(`#publication-${locale}`);
const save = (page: Page) => page.getByRole('button', { name: 'Opslaan' }).click();

export async function exerciseRestrictedNotice(
  page: Page,
  request: APIRequestContext,
  slug: string
): Promise<void> {
  requireApi();
  await login(page, '/admin/probe');
  const edit = await newPage(page, slug, 'Voor leden');
  await expect(page.getByLabel('Wie het mag lezen')).toHaveValue('public');
  const itemId = edit.split('/').at(-1)!;
  const { revision } = await callApi<{
    revision: { id: string; document: Record<string, unknown> };
  }>(request, 'content.item.get', { itemId });
  await callApi(request, 'content.item.update', {
    itemId,
    baseRevisionId: revision.id,
    document: {
      ...revision.document,
      access: { level: 'members', teaser: 'marker' },
      blocks: [{ type: 'paywall', version: 1, props: {} }],
    },
  });
  await page.goto(edit);
  await expect(page.getByLabel('Wie het mag lezen')).toHaveValue('members');
  const boundary = page.locator('.ui-block-text-boundary');
  await expect(boundary).toContainText('Toegangsgrens');
  await expect(boundary).not.toContainText('openbaar');
  await openPublication(page);
  const notice = card(page, 'nl').getByText(
    'Dit item is besloten: bezoekers zonder toegang zien de teaser'
  );
  await expect(notice).toBeVisible();
  // Before the first button in document order, and no button closes it.
  const before = await notice.evaluate((el) => {
    const button = document.querySelector('.ui-status-card button')!;
    return !!(el.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
  await expectNoAxeViolations(page);
  // Another teaser beside the paywall is refused at the teaser choice, and nothing is stored.
  await closePublication(page);
  const teaser = page.locator('#teaser');
  await teaser.selectOption('lead', { force: true });
  await save(page);
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Dit item heeft een betaalmuurblok, en dat werkt alleen');
  await alert.getByRole('link', { name: 'Wat alle anderen zien' }).click();
  await expect(teaser).toBeFocused();
  await expect(teaser).toHaveAttribute('aria-invalid', 'true');
  // The jump's scroll depends on the tier count; a box under the sticky bar fails target-size.
  await page.locator('#level').evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await expectNoAxeViolations(page);
  const now = await callApi(request, 'content.item.get', { itemId });
  expect(now.revision.document.access).toEqual({ level: 'members', teaser: 'marker' });
}
