// Extends the existing real-browser-zoom proof, using its extension and persistent context.
// Rejected: CSS zoom or pageScaleFactor, which do not prove a quarter-size CSS viewport.
import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type Worker } from '@playwright/test';
import { layoutGate } from '../layout';
import { expectNoAxeViolations } from '../axe';
import { seedSiteSettings } from './settings-fixture';

export async function exerciseZoomedNavigation(
  page: Page,
  worker: Worker,
  before: { width: number; ratio: number }
) {
  const slug = `chrome-zoom-${Date.now()}`;
  await seedSiteSettings(slug, `${slug}-single`);
  await page.goto(`http://127.0.0.1:4173/${slug}/home`);
  await worker.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: {
          tabs: {
            query: (query: object) => Promise<{ id: number; url: string }[]>;
            setZoom: (id: number, factor: number) => Promise<void>;
          };
        };
      }
    ).chrome;
    const tab = (await api.tabs.query({})).find((t) => t.url.includes('/chrome-zoom-'))!;
    await api.tabs.setZoom(tab.id, 4);
  });
  await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(before.ratio * 4);
  for (const locale of ['nl', 'en']) {
    await page.goto(`http://127.0.0.1:4173/${slug}/${locale === 'en' ? 'en/' : ''}home`);
    expect(await page.evaluate(() => innerWidth)).toBeCloseTo(before.width / 4, 0);
    const header = page.locator('.site-header');
    await expect(header).toHaveAttribute('data-enhanced', '');
    await layoutGate(page, `header ${locale} at real 400% zoom`, '.site-header');
    await header.locator('.site-languages summary').click();
    await layoutGate(page, `languages ${locale} at real 400% zoom`, '.site-header');
    await header.locator('.site-languages summary').click();
    const menu = header.locator('.site-menu-toggle');
    await menu.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('.site-dialog');
    await dialog.evaluate(async (d) => {
      await Promise.all(d.getAnimations().map((a) => a.finished));
    });
    await layoutGate(page, `panel ${locale} at real 400% zoom`, '.site-dialog');
    await expectNoAxeViolations(page, { label: `navigation ${locale} at real 400% zoom` });
    // Playwright’s CSS-sized viewport screenshot crops Chromium’s zoomed surface. CDP without
    // a CSS clip captures the whole physical viewport; retain the geometry alongside it.
    const cdp = await page.context().newCDPSession(page);
    const screenshot = await cdp.send('Page.captureScreenshot', { captureBeyondViewport: false });
    await writeFile(
      test.info().outputPath(`navigation-browser-zoom-400-${locale}.png`),
      Buffer.from(screenshot.data, 'base64')
    );
    await cdp.detach();
    await test.info().attach(`navigation-zoom-400-${locale}.json`, {
      body: JSON.stringify(
        await page.evaluate(() => ({
          viewport: innerWidth,
          height: innerHeight,
          ratio: devicePixelRatio,
        }))
      ),
      contentType: 'application/json',
    });
    await page.keyboard.press('Escape');
    await expect(menu).toBeFocused();
  }
}
