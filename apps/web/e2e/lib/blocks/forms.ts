// Both reference block types use the same native picker and preserve the rest of the draft.
import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { callApi } from '../api';
import { login } from '../login';
import { editorReady, reloadsEditor } from '../editor';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { expectNoAxeViolations } from '../axe';
import { isA11y } from '../project';
import { tenantId, withInvoker } from '../invoker';
import { systemPrincipal, useCases } from '@mycel/core';

export async function exerciseFormPicker(page: Page, request: APIRequestContext, locale: string) {
  const first = await callApi(request, 'form.create', { kind: 'contact' });
  const second = await callApi(request, 'form.create', { kind: 'contact' });
  const name = {
    nl: `Contact met de campagne ${second.id.slice(-6)}`,
    en: `Contact the campaign team ${second.id.slice(-6)}`,
  };
  await withInvoker(async (i) => {
    const principal = systemPrincipal(await tenantId(), 'picker-fixture');
    const original = await i.run(useCases.getFormForAuthoring, principal, { id: second.id });
    await i.run(useCases.updateForm, principal, {
      baseVersion: original.version,
      value: { ...original.form, name },
    });
  });
  const { item } = await callApi(request, 'content.item.create', {
    slug: `form-picker-${randomUUID()}`,
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl', 'en'],
      title: { nl: 'Formulierproef', en: 'Form test' },
      blocks: [
        { id: 'f', type: 'form', version: 1, props: { formId: first.id } },
        { id: 's', type: 'signup-form', version: 1, props: { formId: first.id } },
        { id: 'h', type: 'heading', version: 1, props: { text: { nl: 'Bewaren', en: 'Keep me' } } },
      ],
    },
  });
  const edit = `/admin/probe/content/${item.id}?locale=${locale}`;
  await login(page, edit, undefined, { 'accept-language': locale });
  await editorReady(page);
  await page.locator('[name="title.' + locale + '"]').fill('Other draft title');
  for (const id of ['f', 's']) {
    const fold = page.locator(`#block-${id}`);
    if ((await fold.getAttribute('open')) === null) await fold.locator(':scope > summary').click();
    const select = page.locator(`select[name="b.${id}.p.formId"]`);
    await expect(select.locator(`option[value="${second.id}"]`)).toHaveText(
      name[locale as 'nl' | 'en']
    );
    await expect(select.locator(`option[value="${first.id}"]`)).toHaveText(first.list);
    await select.focus();
    await select.selectOption({ label: name[locale as 'nl' | 'en'] });
  }
  expect(await page.locator('form#item-edit form').count()).toBe(0);
  if (isA11y()) {
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, '#block-f, #block-s');
    await expectNoAxeViolations(page);
    await page.screenshot({
      path: test.info().outputPath(`form-picker-${locale}-320-200.png`),
      fullPage: true,
    });
  }
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  const { revision } = await callApi(request, 'content.item.get', { itemId: item.id });
  expect(revision.document.title).toEqual(
    locale === 'nl'
      ? { nl: 'Other draft title', en: 'Form test' }
      : { nl: 'Formulierproef', en: 'Other draft title' }
  );
  expect(revision.document.blocks.map((b: { props: unknown }) => b.props)).toEqual([
    { formId: second.id, variant: 'default', width: 'content' },
    { formId: second.id },
    { text: { nl: 'Bewaren', en: 'Keep me' } },
  ]);
  for (const id of ['f', 's'])
    await expect(page.locator(`[data-block-card="block-${id}"] .ui-block-text-kind`)).toHaveText(
      name[locale as 'nl' | 'en']
    );
  // A writer without forms:read keeps native reference editing, with no definition links.
  const email = `picker-${randomUUID()}@probe.test`;
  await withInvoker(async (i) =>
    i.run(useCases.inviteMember, systemPrincipal(await tenantId(), 'picker-test'), {
      email,
      capabilities: ['content:read', 'content:write'],
    })
  );
  await page.context().clearCookies();
  await login(page, edit, email, { 'accept-language': locale });
  await editorReady(page);
  await expect(page.locator('.ui-block-card-body a[href="/admin/probe/forms"]')).toHaveCount(0);
  for (const id of ['f', 's']) {
    const fold = page.locator(`#block-${id}`);
    if ((await fold.getAttribute('open')) === null) await fold.locator(':scope > summary').click();
    await expect(page.locator(`input[name="b.${id}.p.formId"]`)).toHaveValue(second.id);
    await page.locator(`input[name="b.${id}.p.formId"]`).fill(first.id);
  }
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  const saved = await callApi(request, 'content.item.get', { itemId: item.id });
  expect(
    saved.revision.document.blocks
      .slice(0, 2)
      .map((b: { props: { formId: string } }) => b.props.formId)
  ).toEqual([first.id, first.id]);
  // A missing reference is a refused save, never an empty or substituted selection.
  const missing = randomUUID();
  const fold = page.locator('#block-f');
  if ((await fold.getAttribute('open')) === null) await fold.locator(':scope > summary').click();
  await page.locator('input[name="b.f.p.formId"]').fill(missing);
  await page.locator('[name="title.' + locale + '"]').fill('Retained rejected draft');
  await reloadsEditor(page, () =>
    page.locator('button.ui-button[form="item-edit"][formaction^="?/save&"]').click()
  );
  await expect(page.locator('input[name="b.f.p.formId"]')).toHaveValue(missing);
  await expect(page.locator('[name="title.' + locale + '"]')).toHaveValue(
    'Retained rejected draft'
  );
}
