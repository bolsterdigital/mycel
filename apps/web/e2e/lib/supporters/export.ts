// The Supporters list as a CSV file (TODO MY-256 PR 1): the administrator narrows the list and
// downloads what is in view, a plain form post, so both projects walk it; an editor reads the
// list and gets neither the button nor the file. Core (`supporters/export.test.ts`, `util/csv.test.ts`)
// proves the columns, the order, the filter and the formula guard; this proves the screen hands
// the filter over and the browser receives a file. Rejected: a test per filter field here, which
// repeats core through a browser.
import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { NARROW } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

/** `emails` are the rows the list `list` holds, newest activity first. */
export async function exerciseSupporterExport(
  page: Page,
  list: string,
  emails: readonly string[],
  editor: string
) {
  await page.setViewportSize(NARROW);
  await login(page, `/admin/probe/supporters?list=${list}`);
  const button = page.getByRole('button', { name: 'Export as CSV', exact: true });
  if (isA11y()) await expectNoAxeViolations(page, { label: 'supporters with export' });
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  expect(download.suggestedFilename()).toMatch(/^supporters-probe-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await readFile(await download.path(), 'utf8');
  const lines = text.replace(/^﻿/, '').split('\r\n');
  expect(lines[0]).toBe('email,lists,pending_lists,first_seen,last_activity,id');
  expect(lines.slice(1, -1).map((l) => l.split(',')[0])).toEqual(emails);
  // The list stays in view: a download is no navigation.
  expect(new URL(page.url()).searchParams.get('list')).toBe(list);

  // An editor reads supporters but takes none out: no button, and the post itself is refused.
  await page.context().clearCookies();
  await login(page, `/admin/probe/supporters?list=${list}`, editor);
  await expect(page.locator('#supporters tbody tr')).toHaveCount(emails.length);
  await expect(button).toHaveCount(0);
  const refused = await page.request.post('/admin/probe/supporters/export', {
    form: { list },
    headers: { origin: new URL(page.url()).origin },
  });
  expect(refused.status()).toBe(403);
}
