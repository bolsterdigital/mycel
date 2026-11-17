// One editorial task crosses the tier screen and an item's access fields, with the registry as
// read-back: make a tier, change it, restrict an item to it, and be refused without
// `content:publish`. Rejected: a browser test per field, which repeats the catalog and the
// schema checks of core.
import { randomUUID } from 'node:crypto';
import { test, expect, type Browser, type Page, type APIRequestContext } from '@playwright/test';
import { callApi } from '../api';
import { login } from '../login';
import { newPage, reloadsEditor, showEditorTab } from '../editor';
import { expectNoAxeViolations } from '../axe';
import { isA11y } from '../project';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { LIVE_READER, ensureLiveAdmin } from '../content-admin/live-accounts';
import { freshContext } from '../content-admin/fresh-context';

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

/** Opens the Access fold on the Settings tab of an edit screen. */
async function openAccess(page: Page) {
  await showEditorTab(page, 'Instellingen');
  await page
    .locator('details:has(#level)')
    .evaluateAll((folds) => folds.forEach((fold) => ((fold as HTMLDetailsElement).open = true)));
}

const saveItem = (page: Page) =>
  reloadsEditor(page, () => page.getByRole('button', { name: 'Opslaan', exact: true }).click());

export async function exerciseAccessTiers(
  page: Page,
  request: APIRequestContext,
  browser: Browser
) {
  const unique = randomUUID().slice(0, 8);
  const base = '/admin/probe/access';
  const save = () => page.getByRole('button', { name: 'Opslaan', exact: true }).click();

  // A new tier: the slug follows the name, the kind is asked once.
  await login(page, `${base}/new`);
  await page.locator('#tier-name').fill(`Donateurs ${unique}`);
  await page.locator('#tier-description').fill('Voor wie maandelijks geeft');
  await page.locator('#tier-kind').selectOption('paid');
  await page.locator('#tier-order').fill('3');
  await measure(page, 'tier-form-new');
  await save();
  await expect(page).toHaveURL(/\/access\/[0-9a-f-]{36}\?saved=1$/);
  const tierId = new URL(page.url()).pathname.split('/').pop()!;
  expect(await callApi(request, 'content.access_tier.get', { tierId })).toMatchObject({
    slug: `donateurs-${unique}`,
    kind: 'paid',
    order: 3,
    name: { nl: `Donateurs ${unique}` },
    description: { nl: 'Voor wie maandelijks geeft' },
  });

  // Changing it keeps slug and kind, which the form shows as text.
  await expect(page.locator('#tier-kind')).toHaveCount(0);
  await expect(page.locator('main')).toContainText(`donateurs-${unique}`);
  await page.locator('#tier-name').fill(`Vrienden ${unique}`);
  await measure(page, 'tier-form-edit');
  await save();
  await expect(page).toHaveURL(/\?saved=1$/);
  expect(await callApi(request, 'content.access_tier.get', { tierId })).toMatchObject({
    slug: `donateurs-${unique}`,
    kind: 'paid',
    name: { nl: `Vrienden ${unique}` },
  });

  // The list names it and links to its form.
  await page.goto(base);
  await expect(page.getByRole('link', { name: `Vrienden ${unique}`, exact: true })).toHaveAttribute(
    'href',
    `${base}/${tierId}`
  );
  await measure(page, 'tier-list');

  // An item: restricted to a tier without one chosen is refused by name; with one it is stored.
  const edit = await newPage(page, `tier-${test.info().project.name}-${unique}`, 'Voor vrienden');
  const itemId = edit.split('/').at(-1)!;
  await openAccess(page);
  await expect(page.locator('#level')).toHaveValue('public');
  await page.locator('#level').selectOption('tier');
  await saveItem(page);
  await expect(page.getByRole('alert')).toContainText('Kies minstens één toegangsniveau');
  await openAccess(page);
  await page.locator('#level').selectOption('tier');
  await page.getByRole('checkbox', { name: `Vrienden ${unique}`, exact: true }).check();
  await measure(page, 'item-access');
  await saveItem(page);
  await expect(page).toHaveURL(/\?saved/);
  const stored = await callApi(request, 'content.item.get', { itemId });
  expect(stored.revision.document.access).toEqual({
    level: 'tier',
    tierIds: [tierId],
    teaser: 'lead',
  });
  // Opened up again: the tier goes with the level.
  await openAccess(page);
  await expect(
    page.getByRole('checkbox', { name: `Vrienden ${unique}`, exact: true })
  ).toBeChecked();
  await page.locator('#level').selectOption('public');
  await saveItem(page);
  await expect(page).toHaveURL(/\?saved/);
  const opened = await callApi(request, 'content.item.get', { itemId });
  expect(opened.revision.document.access).toEqual({ level: 'public', teaser: 'lead' });

  // A member with only `content:read` sees the list without links and is refused the form and
  // the write (the use case asks for `content:publish`).
  await ensureLiveAdmin();
  const readerContext = await freshContext(browser);
  try {
    const reader = await readerContext.newPage();
    await login(reader, base, LIVE_READER);
    await expect(reader.locator('main')).toContainText(`Vrienden ${unique}`);
    await expect(reader.getByRole('link', { name: `Vrienden ${unique}`, exact: true })).toHaveCount(
      0
    );
    expect((await reader.request.get(`${base}/new`)).status()).toBe(403);
    const denied = await reader.request.post(`${base}/${tierId}`, {
      headers: { origin: 'http://127.0.0.1:4173' },
      form: { name: 'Gekaapt', order: '0', baseUpdatedAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(denied.status()).toBe(403);
  } finally {
    await readerContext.close();
  }
  expect(await callApi(request, 'content.access_tier.get', { tierId })).toMatchObject({
    name: { nl: `Vrienden ${unique}` },
  });
}
