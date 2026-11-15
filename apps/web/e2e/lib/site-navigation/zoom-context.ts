// Independent zoom tasks share the real Chromium extension, not one cumulative test deadline.
// Rejected: a larger timeout or CSS zoom, which respectively masks growth or skips real reflow.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Page, type Worker } from '@playwright/test';

export async function setBrowserZoom(page: Page, worker: Worker, factor: number) {
  await worker.evaluate(
    async ({ url, factor }) => {
      // chrome is provided by the measurement extension, not by application code.
      const api = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query: (q: object) => Promise<{ id: number; url: string }[]>;
              setZoom: (id: number, factor: number) => Promise<void>;
            };
          };
        }
      ).chrome;
      const tab = (await api.tabs.query({})).find((tab) => tab.url === url)!;
      await api.tabs.setZoom(tab.id, factor);
    },
    { url: page.url(), factor }
  );
}

export async function withBrowserZoom(
  factor: number,
  run: (measurement: {
    page: Page;
    worker: Worker;
    before: { width: number; ratio: number };
  }) => Promise<void>,
  { javaScriptEnabled = true }: { javaScriptEnabled?: boolean } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), 'mycel-zoom-'));
  let context;
  try {
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Mycel layout measurement',
        version: '1.0',
        permissions: ['tabs'],
        background: { service_worker: 'worker.js' },
      })
    );
    await writeFile(
      join(directory, 'worker.js'),
      'chrome.runtime.onInstalled.addListener(() => {});'
    );
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: null,
      javaScriptEnabled,
      args: [
        `--disable-extensions-except=${directory}`,
        `--load-extension=${directory}`,
        '--window-size=1440,1000',
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173/probe/articles/quality-article-v3');
    const before = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }));
    await setBrowserZoom(page, worker, factor);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(before.ratio * factor);
    expect(await page.evaluate(() => innerWidth)).toBeCloseTo(before.width / factor, 0);
    await test.info().attach('browser-zoom-context.json', {
      body: JSON.stringify({
        before,
        factor,
        javaScriptEnabled,
        version: context.browser()?.version(),
      }),
      contentType: 'application/json',
    });
    await run({ page, worker, before });
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
