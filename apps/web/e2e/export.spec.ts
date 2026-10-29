// flow: access
// Self-service export (TODO #28): a site administrator asks for an archive, the e2e worker builds
// it, and the download is a tar in the format `mycel import` reads (its manifest first). Runs
// without JavaScript and under axe like the other admin specs; the UI gate (skill
// ui-action-layout) checks the ask button and a card's download link at 320 CSS px and 200% text.
// An ask while one is being built gets that one back, so the two projects may share an archive.

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';

const run = promisify(execFile);

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

/** Ask for an archive (or get the one being built) and reload until one can be downloaded. */
async function readyArchive(page: Page) {
  await page.getByRole('button', { name: 'Archief aanvragen' }).click();
  await expect(page.getByRole('status')).toContainText('archief');
  // The newest card may be another project's request still waiting; take one that is ready.
  const card = page
    .locator('article', { has: page.getByRole('link', { name: 'Archief downloaden' }) })
    .first();
  await expect(async () => {
    await page.goto('/admin/probe/export');
    await expect(card).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 90_000, intervals: [1000, 2000, 3000] });
  return card;
}

test('an administrator asks for an archive and downloads it without JavaScript', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await login(page, '/admin/probe');
  await page.getByRole('link', { name: 'Deze site exporteren' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Export' })).toBeVisible();
  await expect(page.locator('main')).toContainText('7 dagen te downloaden');
  await expectNoAxeViolations(page);

  const card = await readyArchive(page);
  await expect(card).toContainText('Klaar');
  const link = card.getByRole('link', { name: 'Archief downloaden' });
  await expectNoAxeViolations(page);

  // Through the page's own session, as media.spec.ts downloads an original: a browser download
  // would leave out the test's forwarded-address headers, which the server here requires.
  const href = (await link.getAttribute('href'))!;
  expect(href).toMatch(/^\/admin\/probe\/export\/[0-9a-f-]{36}\?exp=\d+&sig=/);
  expect(await link.getAttribute('download')).not.toBeNull();
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/x-tar');
  expect(response.headers()['content-disposition']).toMatch(
    /^attachment; filename="probe-\d{4}-\d{2}-\d{2}\.tar"$/
  );
  expect(response.headers()['cache-control']).toBe('private, no-store');
  const file = test.info().outputPath('probe.tar');
  await writeFile(file, await response.body());
  const { stdout } = await run('tar', ['-tf', file]);
  expect(stdout.split('\n')).toContain('./manifest.json');
  expect(stdout).toContain('./tables/supporters.ndjson');

  // The link is bound to the archive and expires; without its signature it is a 404.
  const bare = await page.request.get(href.split('?')[0]!);
  expect(bare.status()).toBe(404);
});

test.describe('UI gate: the export actions at 320 CSS px and 200% text', () => {
  test.use({ viewport: NARROW });

  for (const text of TEXT_SIZES) {
    test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
      test.setTimeout(120_000);
      await login(page, '/admin/probe/export');
      await readyArchive(page);
      await setTextSize(page, text);
      await layoutGate(page, 'export actions', 'main');
    });
  }
});
