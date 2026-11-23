// A page's split header (MY-287, ADR 025 amended 2026-11-23): the editor chooses it on a page
// with a hero image, the button's text and address appear with the choice and save, and the
// published page opens with title, lead and button in a panel beside the image, one h1, whole at
// 320 px and 200% text. Core and component suites cover the schema, the fallbacks and an
// unavailable target. Rejected: a spec of its own (the e2e budget) and a test per layout, since
// the cover shares its markup with the article's, which public-site.spec.ts already measures.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases, type ContentDocument } from '@mycel/core';
import { callApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { editorReady, reloadsEditor } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

/** A page with the quality article's image as its hero, in nl. */
async function heroPage(request: APIRequestContext, slug: string) {
  const [source] = (
    await callApi(request, 'content.item.list', { type: 'article', slug: 'quality-article-v3' })
  ).items;
  const { revision } = await callApi(request, 'content.item.get', { itemId: source.id });
  const image = (revision.document as ContentDocument).blocks.find((b) => b.type === 'image');
  expect(image, 'the quality article has an image block').toBeTruthy();
  return callApi(request, 'content.item.create', {
    slug,
    document: {
      type: 'page',
      defaultLocale: 'nl',
      locales: ['nl'],
      title: { nl: 'Rotterdam is van ons' },
      lead: { nl: 'Een stad waar iedereen kan rondkomen zonder zorgen.' },
      heroImageId: (image!.props as { mediaId: string }).mediaId,
      heroAlt: { nl: 'Een straat met bomen.' },
      blocks: [],
    },
  });
}

export async function exerciseSplitHeader(page: Page, request: APIRequestContext) {
  const slug = `e2e-split-287-${randomUUID().slice(0, 8)}`;
  const { item } = await heroPage(request, slug);
  await login(page, `/admin/probe/content/${item.id}`, undefined, { 'accept-language': 'en' });
  await editorReady(page);
  await page.locator('#headerLayout').selectOption('split');
  await reloadsEditor(page, () =>
    page.getByRole('button', { name: 'Save', exact: true }).first().click()
  );
  await page.locator('[id="headerActionLabel.nl"]').fill('Word actief');
  // With JavaScript the picker's search takes an address on leaving it; without, select and field.
  if (isA11y()) {
    await page.locator('#headerActionTarget-search').fill('https://example.org/doe-mee');
    await page.locator('#headerActionTarget-search').press('Tab');
  } else {
    await page.locator('#headerActionTarget').selectOption('url');
    await page.locator('#headerActionUrl').fill('https://example.org/doe-mee');
  }
  await reloadsEditor(page, () =>
    page.getByRole('button', { name: 'Save', exact: true }).first().click()
  );
  await expect(page.locator('#headerLayout')).toHaveValue('split');
  await expect(page.locator('[id="headerActionLabel.nl"]')).toHaveValue('Word actief');

  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker) => {
    const { revision } = await invoker.run(useCases.getItem, principal, { itemId: item.id });
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
  });
  for (const size of [
    { width: 1440, height: 900 },
    { width: 375, height: 700 },
  ]) {
    await page.setViewportSize(size);
    expect((await page.goto(`/probe/${slug}`))?.status()).toBe(200);
    const header = page.locator('main > header.page-split');
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(header.locator('.page-split-panel h1')).toHaveText('Rotterdam is van ons');
    await expect(header.getByRole('link', { name: 'Word actief' })).toHaveAttribute(
      'href',
      'https://example.org/doe-mee'
    );
    await expect(header.locator('.page-split-media img')).toHaveAttribute('fetchpriority', 'high');
    const boxes = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      return {
        panel: box('.page-split-panel'),
        media: box('.page-split-media'),
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(boxes.overflow).toBeLessThanOrEqual(0);
    // Side by side on a wide screen, the image under the panel on a phone.
    if (size.width > 800) expect(boxes.media.left).toBeGreaterThanOrEqual(boxes.panel.right - 1);
    else expect(boxes.media.top).toBeGreaterThanOrEqual(boxes.panel.bottom - 1);
  }
  if (!isA11y()) return;
  await expectNoAxeViolations(page);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'split header', 'main');
  await page.screenshot({
    path: test.info().outputPath('split-header-320-200.png'),
    fullPage: true,
  });
  await setTextSize(page, '100%');
}
