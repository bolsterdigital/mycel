// Whether the images a screen shows are real pictures. A media list that answered 200, or an
// `<img>` that is in the DOM, says nothing about the bytes behind its `src`: a row whose file is
// in another checkout's blob store renders as a broken image while every request around it
// succeeds. This loads every image in `scope`, also the lazy ones in a closed dialog,
// and fails on a failed or non-image response and on `naturalWidth === 0`.
// Rejected: counting `<img>` elements or checking `src` strings (both pass on a 404).

import { expect, type Locator, type Page, type Response } from '@playwright/test';

/** Watch the image responses of `page` from now on; `bad()` lists the failed ones. */
export function watchImages(page: Page) {
  const failed: string[] = [];
  const onResponse = (r: Response) => {
    if (r.request().resourceType() !== 'image') return;
    const type = r.headers()['content-type'] ?? '';
    if (r.status() >= 400 || !type.startsWith('image/'))
      failed.push(`${r.status()} ${type} ${r.url()}`);
  };
  page.on('response', onResponse);
  page.on('requestfailed', (r) => {
    if (r.resourceType() === 'image') failed.push(`failed ${r.url()}`);
  });
  return { bad: () => [...failed] };
}

/** Every `<img>` in `scope` that has a source decodes to real pixels; returns how many there are. */
export async function expectPixels(scope: Locator, what: string): Promise<number> {
  const results = await scope.evaluateAll(async (nodes) =>
    Promise.all(
      (nodes as HTMLImageElement[])
        .filter((img) => img.getAttribute('src') || img.getAttribute('srcset'))
        .map(async (img) => {
          img.loading = 'eager';
          await img.decode().catch(() => null);
          return { src: img.currentSrc || img.src, width: img.naturalWidth };
        })
    )
  );
  expect(results.length, `${what}: no image with a source`).toBeGreaterThan(0);
  expect(
    results.filter((r) => r.width === 0).map((r) => r.src),
    `${what}: images without pixels`
  ).toEqual([]);
  return results.length;
}
