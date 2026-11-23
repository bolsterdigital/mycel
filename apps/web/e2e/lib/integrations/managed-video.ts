// The playback boundary with a fixture origin: no network before a visitor starts playback,
// then an intentionally bad manifest and real browser-decodable MP4 bytes.
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { isA11y } from '../project';

const host = 'https://mycel-fixture.b-cdn.net';
const recording = fileURLToPath(
  new URL('../../../../../packages/api/fixtures/bunny/test-recording.mp4', import.meta.url)
);

export async function exerciseManagedVideo(page: Page) {
  const asked: string[] = [];
  await page.route(`${host}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    asked.push(pathname);
    const headers = { 'access-control-allow-origin': '*', 'accept-ranges': 'bytes' };
    if (pathname.endsWith('.m3u8'))
      return route.fulfill({
        headers,
        contentType: 'application/vnd.apple.mpegurl',
        body: 'fixture: malformed HLS',
      });
    return route.fulfill({ headers, contentType: 'video/mp4', path: recording });
  });
  const title = /Afspelen|Play video/;
  const main = '/probe/blok-video-shared';
  if (isA11y()) {
    await page.setViewportSize(NARROW);
    for (const [path, watch] of [
      [main, 'Bekijk extern'],
      ['/probe/en/blok-video-shared', 'Watch externally'],
    ] as const) {
      await page.goto(path);
      await setTextSize(page, '200%');
      await layoutGate(page, watch, '.video-details');
      const action = page.getByRole('link', { name: watch, exact: true });
      const size = (await action.boundingBox())!;
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
  await page.goto(main);
  expect(asked).toEqual([]);
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
}
