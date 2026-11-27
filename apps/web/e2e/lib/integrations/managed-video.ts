// The playback boundary with a fixture origin: no network before a visitor starts playback,
// then an intentionally bad manifest and real browser-decodable MP4 bytes.
import { randomUUID } from 'node:crypto';
import { EXAMPLE_IDS, systemPrincipal, useCases } from '@mycel/core';
import { tenantId, withInvoker } from '../invoker';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { isA11y } from '../project';

const host = 'https://mycel-fixture.b-cdn.net';
const recording = fileURLToPath(
  new URL('../../../../../packages/api/fixtures/bunny/test-recording.mp4', import.meta.url)
);

/**
 * The fixture CDN: a malformed manifest, so the player falls back to the real MP4 bytes, and a
 * 403 for a signature at or past `now()`. Returns the paths asked, in order.
 */
export async function routeFixtureCdn(page: Page, now: () => number = () => 0) {
  const asked: string[] = [];
  await page.route(`${host}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    asked.push(pathname);
    const headers = { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
    const expires = Number(/&expires=(\d+)/.exec(pathname)?.[1]);
    if (expires <= now()) return route.fulfill({ status: 403, headers });
    if (pathname.endsWith('.m3u8'))
      return route.fulfill({
        headers,
        contentType: 'application/vnd.apple.mpegurl',
        body: 'fixture: malformed HLS',
      });
    return route.fulfill({ headers, contentType: 'video/mp4', path: recording });
  });
  return asked;
}

export async function exerciseManagedVideo(page: Page) {
  let cdnNow = 0;
  const asked = await routeFixtureCdn(page, () => cdnNow);
  const title = /Afspelen|Play video/;
  const main = '/probe/blok-video-shared';
  if (isA11y()) {
    await page.setViewportSize(NARROW);
    for (const [path, watch] of [
      [main, 'Bekijk extern'],
      ['/probe/en/blok-video-shared', 'Watch externally'],
    ] as const) {
      await page.goto(path);
      const credit = page.locator('.video-credit');
      await credit.evaluate((element) => {
        element.prepend('Tom Koerner / U.S. Fish and Wildlife Service · ');
      });
      const watchLink = page.getByRole('link', { name: watch, exact: true });
      const creditBox = (await credit.boundingBox())!;
      const linkBox = (await watchLink.boundingBox())!;
      expect(creditBox.x + creditBox.width).toBeLessThanOrEqual(linkBox.x);
      expect(linkBox.y).toBeLessThan(creditBox.y + creditBox.height);
      await setTextSize(page, '200%');
      await layoutGate(page, watch, '.video-details');
      const size = (await watchLink.boundingBox())!;
      expect(size.height).toBeGreaterThanOrEqual(44);
      expect(size.width).toBeGreaterThanOrEqual(44);
      await expectNoAxeViolations(page, { label: watch });
    }
    await test
      .info()
      .attach('video-320-200-en', { body: await page.screenshot(), contentType: 'image/png' });
  }
  await page.goto('/probe/articles/quality-article-v3');
  await expect(page.getByRole('button', { name: title })).toHaveCount(1);
  // Give each browser a real placement it can withdraw independently of the shared examples.
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const slug = 'video-' + randomUUID();
  const uniqueTitle = slug.replaceAll('-', '');
  const search = () => page.request.get('/probe/search?q=' + uniqueTitle + '+rivier');
  const itemId = await withInvoker(async (invoker) => {
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: uniqueTitle },
        blocks: [{ id: 'film', type: 'video', version: 1, props: { videoId: EXAMPLE_IDS.video } }],
      },
    });
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    return item.id;
  });
  await page.goto('/probe/' + slug);
  expect(asked).toEqual([]);
  expect(await (await search()).text()).toContain('href="/probe/' + slug + '"');
  await expect(page.locator('.block.video details')).toContainText('Langs de rivier.');
  const play = page.getByRole('button', { name: title });
  const endpoint = (await play.locator('..').getAttribute('action'))!;
  const ungranted = await page.request.get(endpoint);
  expect(ungranted.status()).toBe(404);
  await play.focus();
  const started = page.waitForResponse(
    (res) => res.request().method() === 'POST' && res.url().endsWith(endpoint)
  );
  await page.keyboard.press('Enter');
  const response = await started;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['content-security-policy']).toContain(host);
  const player = isA11y() ? page.frameLocator('.managed-video-frame') : page;
  const video = player.locator('video');
  await expect(video).toHaveAttribute('controls', '');
  if (isA11y()) {
    await expect.poll(() => video.evaluate(() => document.readyState)).toBe('complete');
    // The press on the poster was the press on play: it starts without a second one.
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused)).toBe(true);
  }
  await video.evaluate((el: HTMLVideoElement) => {
    void el.play().catch(() => {});
  });
  if (isA11y()) await expect.poll(() => asked.some((path) => path.endsWith('.m3u8'))).toBe(true);
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(0.2);
  expect(asked.some((path) => path.endsWith('play_180p.mp4'))).toBe(true);
  const track = await video.locator('track').evaluate((el: HTMLTrackElement) => el.src);
  const cues = await page.request.get(track);
  expect(cues.headers()['content-type']).toContain('text/vtt');
  expect(await cues.text()).toContain('Langs de rivier.');

  // Advance the player and CDN to the first signature's deadline. The server issues real
  // signatures to the replacement request, so wait for a distinct signing second first.
  const original = (await video.getAttribute('data-mp4'))!;
  cdnNow = Number(/&expires=(\d+)/.exec(original)![1]);
  await expect.poll(() => Math.floor(Date.now() / 1000)).toBeGreaterThan(cdnNow - 900);
  await video.evaluate((el: HTMLVideoElement) => el.pause());
  if (isA11y()) {
    const refused = await video.evaluate(async (_el, url) => (await fetch(url)).status, original);
    expect(refused).toBe(403);
    await page.clock.setFixedTime(new Date(Date.now() + 901_000));
    const renewal = page.waitForResponse(
      (r) => r.url().endsWith(endpoint) && r.request().method() === 'POST'
    );
    await video.evaluate((el: HTMLVideoElement) => {
      el.currentTime = 3;
    });
    const renewed = await renewal;
    expect(renewed.status()).toBe(200);
    expect(renewed.headers()['cache-control']).toContain('no-store');
    const grant = await renewed.json();
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentSrc))
      .toBe(grant.mp4);
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
      .toBeCloseTo(3);
  } else {
    const refused = page.waitForResponse((r) => r.url() === original && r.status() === 403);
    await video.evaluate((el: HTMLVideoElement) => {
      el.load();
      void el.play().catch(() => {});
    });
    await refused;
    await page.getByRole('button', { name: 'Video opnieuw starten' }).click();
  }
  await video.evaluate((el: HTMLVideoElement) => {
    void el.play().catch(() => {});
  });
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThan(isA11y() ? 3.1 : 0.2);
  expect(
    asked.some((path) => path.endsWith('.mp4') && Number(/&expires=(\d+)/.exec(path)?.[1]) > cdnNow)
  ).toBe(true);
  await video.evaluate((el: HTMLVideoElement) => el.pause());
  await withInvoker((invoker) =>
    invoker.run(useCases.unpublishItem, principal, { itemId, locale: 'nl' })
  );
  expect(await (await search()).text()).not.toContain('href="/probe/' + slug + '"');
  const denied = page.waitForResponse(
    (r) => r.url().endsWith(endpoint) && r.request().method() === 'POST'
  );
  if (isA11y()) {
    await page.clock.setFixedTime(new Date(Date.now() + 1_802_000));
    await video.evaluate((el: HTMLVideoElement) => {
      el.currentTime = 1;
    });
  } else await page.getByRole('button', { name: 'Video opnieuw starten' }).click();
  expect((await denied).status()).toBe(404);
  await expect(
    player.getByText('Deze video is momenteel niet beschikbaar.', { exact: false })
  ).toBeVisible();
}
