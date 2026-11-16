// One editorial task for an event: the Events list makes a page with the event profile,
// the editor sets when and where above the blocks, publishing serves them in the header and as
// `Event` structured data. Core and database suites cover the validation and the profile rules.
// Rejected: a spec of its own (the e2e budget) and checking each refusal in the browser.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { editorReady, reloadsEditor } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';
import { openPublication } from '../publication';

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

export async function exerciseEventPage(page: Page) {
  const title = `Buurtavond ${randomUUID().slice(0, 8)}`;
  await login(page, '/admin/probe/content?type=page&profile=event', undefined, {
    'accept-language': 'en',
  });
  await expect(page.locator('h1')).toHaveText('Events');
  await expect(page.getByRole('link', { name: 'Events', exact: true })).toHaveAttribute(
    'aria-current',
    'page'
  );
  await page.getByRole('button', { name: 'New event', exact: true }).first().click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  await editorReady(page);
  const itemId = new URL(page.url()).pathname.split('/').pop()!;
  await page.locator('#title\\.nl').fill(title);
  await page.locator('#eventStartsAt').fill('2027-03-05T20:00');
  await page.locator('#eventEndsAt').fill('2027-03-05T22:00');
  await page.locator('[id="eventLocation.nl"]').fill('Buurthuis, Kerkstraat 1');
  await page.locator('#eventOnlineUrl').fill('https://example.org/live');
  await reloadsEditor(page, () =>
    page.getByRole('button', { name: 'Save', exact: true }).first().click()
  );
  await expect(page.locator('#eventStartsAt')).toHaveValue('2027-03-05T20:00');
  // The editor of an event sits under Events, and its way back leads there.
  await expect(page.locator('a[aria-current="page"]', { hasText: 'Events' })).toHaveCount(1);
  await expect(page.locator(`a[href$="profile=event#item-${itemId}"]`)).toHaveCount(1);
  await expect(page.locator('[id="eventLocation.nl"]')).toHaveValue('Buurthuis, Kerkstraat 1');
  await measure(page, 'event-edit');
  await openPublication(page);
  await reloadsEditor(page, () =>
    page.locator('#publication-nl').getByRole('button', { name: 'Publish', exact: true }).click()
  );
  await expect(page).toHaveURL(/\?done=publish/);

  const principal = systemPrincipal(await tenantId(), 'e2e');
  const { item } = await withInvoker((invoker) =>
    invoker.run(useCases.getItem, principal, { itemId })
  );
  expect(item.profile).toBe('event');
  const response = await page.goto(`/probe/${item.slug}`);
  expect(response?.status()).toBe(200);
  const when = page.locator('.page-event time');
  await expect(when).toHaveAttribute('datetime', '2027-03-05T20:00');
  await expect(when).toHaveText('vrijdag 5 maart 2027, 20:00–22:00');
  await expect(page.locator('.page-event')).toContainText('Buurthuis, Kerkstraat 1');
  await expect(page.locator('.page-event a')).toHaveAttribute('href', 'https://example.org/live');
  const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').innerHTML());
  expect(schema).toMatchObject({ '@type': 'Event', name: title });
  expect(schema.startDate).toMatch(/^2027-03-05T20:00:00[+-]\d\d:\d\d$/);
  await measure(page, 'event-public');
}
