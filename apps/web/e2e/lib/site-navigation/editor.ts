// The CMS task of the menu editor (brief site-navigation § 10): name a menu, find a page and link
// it, give the link a text of its own and take it back to the page's title, order and nest two
// levels with the keyboard and with clicks (the same native submits without JavaScript), and
// have a stale step refused. The registry is the read-back. In the a11y project the menu and the
// item form also pass axe and the layout gate at 320 CSS px and 200% text, where the row's
// actions must stay whole (skill ui-action-layout).
// Rejected: a browser test per button, which would repeat the unit tests of menu-edit.ts.
import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { tenantId, withInvoker } from '../invoker';
import { login } from '../login';
import { isA11y } from '../project';

interface Navigation {
  revisionId: string;
  document: {
    menus: { id: string; nodes: { id: string; label?: Record<string, string> }[] }[];
    placements: unknown;
  };
}

async function measure(page: Page, label: string) {
  if (!isA11y()) return;
  await expectNoAxeViolations(page, { label });
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, label, 'main');
  await page.screenshot({ path: test.info().outputPath(`${label}-320-200.png`), fullPage: true });
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function exerciseMenuEditor(page: Page, request: APIRequestContext) {
  const unique = randomUUID().slice(0, 8);
  const title = `Menudoel ${unique}`;
  const { item, revision } = await callApi(request, 'content.item.create', {
    slug: `menudoel-${unique}`,
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: title },
      blocks: [],
    },
  });
  // The seed key writes but does not publish; the page goes live as the system would do it.
  const system = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker((invoker) =>
    invoker.run(useCases.publishItem, system, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    })
  );
  const items = page.locator('#menu-items');
  const subItems = (of: string) => items.getByRole('list', { name: `Sub-items of ${of}` });
  const save = () => page.getByRole('button', { name: 'Save', exact: true }).click();

  // A menu gets a name first, then its items.
  await login(page, '/admin/probe/navigation/new', undefined, { 'accept-language': 'en' });
  await page.locator('#menu-name').fill(`Menu ${unique}`);
  await page.getByRole('button', { name: 'Create menu' }).click();
  await expect(page).toHaveURL(/\/navigation\/[0-9a-f-]{36}\?(saved|merged)=1$/);
  const menuUrl = page.url().replace(/\?.*$/, '');
  const menuId = menuUrl.split('/').pop()!;
  // The other project edits its own menu of the same site meanwhile: a save may say it merged.
  const done = new RegExp(`/navigation/${menuId}\\?(saved|merged)=1$`);
  await expect(page.getByRole('status')).toContainText('Saved');

  // Find the page and link it: the link reads the page's published title.
  await page.getByRole('link', { name: 'Add link' }).click();
  if (isA11y()) {
    const search = page.getByRole('combobox', { name: 'Links to' });
    await search.fill(title.toLowerCase());
    await expect(page.getByRole('option', { name: new RegExp(title) })).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  } else await page.locator('#item-target').selectOption(item.id);
  await measure(page, 'menu-item-form');
  await save();
  await expect(page).toHaveURL(done);
  await expect(items.getByRole('listitem').first()).toContainText(title);
  await expect(items).toContainText('Page title');

  // An address has no title to take over, so it needs a text; then a group to nest under.
  await page.getByRole('link', { name: 'Add link' }).click();
  if (isA11y()) {
    await page.getByRole('combobox', { name: 'Links to' }).fill('/elders');
    await page.getByRole('option', { name: 'Use address: /elders' }).click();
  } else {
    await page.locator('#item-target').selectOption('url');
    await page.locator('#item-url').fill('/elders');
  }
  await save();
  await expect(page.getByRole('alert')).toContainText('fill in the menu text');
  // What was chosen is still there after the refusal.
  await expect(page.locator('#item-url')).toHaveValue('/elders');
  await page.locator('#item-label').fill('Elders');
  await save();
  await page.getByRole('link', { name: 'Add group' }).click();
  await page.locator('#item-label').fill('Meer');
  await save();
  await expect(items.locator(':scope > ol > li')).toHaveCount(3);

  // Order with the keyboard, nest with a click: [page, Elders, Meer] becomes [page, Meer > Elders].
  await page.getByRole('button', { name: 'Move up: Meer' }).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(done);
  await expect(items.locator(':scope > ol > li').nth(1)).toContainText('Meer');
  await page.getByRole('button', { name: 'Make sub-item: Elders' }).click();
  await expect(subItems('Meer')).toContainText('Elders');
  // A group and a node with sub-items cannot become a third level.
  await expect(page.getByRole('button', { name: 'Make sub-item: Meer' })).toHaveCount(0);
  await measure(page, 'menu-items');

  // A text of its own wins over the title; emptied, the title is back.
  await page.getByRole('link', { name: `Edit: ${title}` }).click();
  await expect(page.locator('#item-label-hint')).toContainText(title);
  await page.locator('#item-label').fill('Eigen tekst');
  await save();
  await expect(items).toContainText('Own menu text');
  await page.getByRole('link', { name: 'Edit: Eigen tekst' }).click();
  await page.locator('#item-label').fill('');
  await save();
  await expect(items.getByRole('listitem').first()).toContainText(title);
  await expect(items).not.toContainText('Eigen tekst');

  // Someone else gives the same link another text while this window has its form open: the
  // stale save is refused, and what they saved stands.
  await page.getByRole('link', { name: `Edit: ${title}` }).click();
  const before = await callApi<Navigation>(request, 'site.navigation.get', {});
  const relabel = (label: string) => ({
    ...before.document,
    menus: before.document.menus.map((m) =>
      m.id === menuId
        ? { ...m, nodes: m.nodes.map((n, i) => (i === 0 ? { ...n, label: { nl: label } } : n)) }
        : m
    ),
  });
  await callApi(request, 'site.navigation.update', {
    baseRevisionId: before.revisionId,
    document: relabel('Van hen'),
  });
  await page.locator('#item-label').fill('Van mij');
  await save();
  await expect(page.getByRole('alert')).toContainText('someone changed the same part');
  await expect(page.locator('#item-label')).toHaveValue('Van mij');
  const after = await callApi<Navigation>(request, 'site.navigation.get', {});
  expect(after.document.menus.find((m) => m.id === menuId)).toEqual(
    relabel('Van hen').menus.find((m) => m.id === menuId)
  );

  // Reloaded, the editor works on the newest revision again; the menu goes with its items.
  await page.goto(menuUrl);
  await page.locator('#menu-delete summary').click();
  await page.getByRole('button', { name: 'Yes, delete menu' }).click();
  await expect(page).toHaveURL(/\/navigation\?(saved|merged)=1$/);
  await expect(page.locator('main')).not.toContainText(`Menu ${unique}`);
}
