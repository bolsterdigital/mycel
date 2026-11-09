// The same editorial metadata round trip in native forms and the enhanced page/article editor.
import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { callApi } from '../api';
import { login } from '../login';
import { editorReady, reloadsEditor } from '../editor';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { expectNoAxeViolations } from '../axe';
import { isA11y } from '../project';

export async function exerciseBlockNames(
  page: Page,
  request: APIRequestContext,
  type: 'page' | 'article'
) {
  const { item } = await callApi(request, 'content.item.create', {
    slug: `names-${type}-${randomUUID()}`,
    document: {
      type,
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Namen', en: 'Names' },
      blocks: [
        {
          id: 'one',
          type: 'heading',
          version: 1,
          name: { en: 'English internal' },
          props: { text: { nl: 'Automatische kop', en: 'Automatic heading' } },
        },
      ],
    },
  });
  await login(page, `/admin/probe/content/${item.id}?locale=nl`);
  await editorReady(page);
  const name = page.locator('[name="b.one.name.nl"]');
  await expect(name).toHaveValue('');
  await expect(name).toHaveAttribute('placeholder', 'Automatische kop');
  await name.focus();
  await name.pressSequentially('INTERNAL-NAME-SENTINEL');
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  await expect(name).toHaveValue('INTERNAL-NAME-SENTINEL');
  const saved = await callApi(request, 'content.item.get', { itemId: item.id });
  expect(saved.revision.document.blocks[0].name).toEqual({
    nl: 'INTERNAL-NAME-SENTINEL',
    en: 'English internal',
  });
  if (isA11y()) {
    await page.locator('[data-block-all="collapse"]').click();
    await expect(name).toBeVisible();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, '.ui-block-card-head');
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: test.info().outputPath(`block-name-${type}-320-200.png`),
      fullPage: true,
    });
  }
  await page.locator('[data-block-card] .ui-block-card-more > summary').click();
  await reloadsEditor(page, () => page.locator('button[name="duplicate"]').click());
  const duplicated = await callApi(request, 'content.item.get', { itemId: item.id });
  expect(duplicated.revision.document.blocks).toHaveLength(2);
  expect(duplicated.revision.document.blocks[1].name).toEqual(
    saved.revision.document.blocks[0].name
  );
  expect(duplicated.revision.document.blocks[1].id).not.toBe('one');
  // Clear only the original; its duplicate retains the complete metadata.
  await name.fill('');
  if (isA11y())
    await expect(page.locator('[data-block-card="block-one"] [data-block-name]')).toHaveText(
      'Automatische kop'
    );
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  await expect(name).toHaveValue('');
  await expect(page.locator('[data-block-card="block-one"] [data-block-name]')).toHaveText(
    'Automatische kop'
  );
  await page.goto(`/admin/probe/content/${item.id}?locale=en`);
  await editorReady(page);
  const english = page.locator('[name="b.one.name.en"]');
  await expect(english).toHaveValue('English internal');
  await english.fill('English changed');
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  await expect(english).toHaveValue('English changed');
  const final = await callApi(request, 'content.item.get', { itemId: item.id });
  expect(final.revision.document.blocks[0].name).toEqual({ en: 'English changed' });
}
