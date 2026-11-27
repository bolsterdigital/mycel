// A media article (MY-305; ADR 025, amended 2026-11-27): the first recording on top with its
// transcript to read along. Without a script the transcript is a list with visible times; with
// one the lines seek, follow, search, link to a moment and switch the captions. The recording is
// the shared fixture (three lines, one speaker) behind the fixture CDN of the managed-video flow.
import { randomUUID } from 'node:crypto';
import { EXAMPLE_IDS, systemPrincipal, useCases } from '@mycel/core';
import { expect, test, type Page } from '@playwright/test';
import { expectNoAxeViolations } from '../axe';
import { routeFixtureCdn } from '../integrations/managed-video';
import { tenantId, withInvoker } from '../invoker';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { forwarded } from '../login';
import { isA11y } from '../project';

const paragraph = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function publishMediaArticle() {
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const slug = 'media-' + randomUUID().slice(0, 8);
  await withInvoker(async (invoker) => {
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Langs de rivier', en: 'Along the river' },
        lead: { nl: 'Een gesprek over otters.', en: 'A conversation about otters.' },
        presentation: { profile: 'media' },
        blocks: [
          { id: 'film', type: 'video', version: 1, props: { videoId: EXAMPLE_IDS.video } },
          {
            id: 'tekst',
            type: 'rich-text',
            version: 1,
            props: {
              content: {
                nl: paragraph('De otter is terug.'),
                en: paragraph('The otter is back.'),
              },
            },
          },
        ],
      },
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
  });
  return slug;
}

export async function exerciseMediaProfile(page: Page) {
  test.setTimeout(120_000);
  // The play form posts behind the proxy's protocol header, as the server's origin check expects.
  await page.context().setExtraHTTPHeaders(forwarded());
  await routeFixtureCdn(page);
  const slug = await publishMediaArticle();
  const path = (locale: 'nl' | 'en') => `/probe/${locale === 'en' ? 'en/' : ''}articles/${slug}`;
  const stage = page.locator('.media-stage');
  const lines = stage.locator('.read-along-lines > li');

  // The recording is the header: title, lead, player, transcript, the duration in the meta line;
  // the body no longer repeats it, and no transcript hides behind a disclosure.
  await page.goto(path('nl'));
  await expect(page.locator('h1')).toHaveText('Langs de rivier');
  await expect(stage.locator('form[data-managed-video]')).toHaveCount(1);
  await expect(page.locator('.block.video')).toHaveCount(0);
  await expect(page.locator('.article-meta')).toContainText('1 min');
  await expect(page.locator('.article-meta')).not.toContainText('lezen');
  await expect(stage.locator('details')).toHaveCount(0);
  await expect(lines).toHaveCount(3);
  await expect(lines.nth(1).locator('time')).toHaveText('0:02');
  await expect(lines.nth(1).locator('.read-along-speaker')).toHaveText('Sam');
  await expect(lines.nth(1).locator('.read-along-text')).toHaveText('Een otter zwemt.');

  if (!isA11y()) {
    // Without a script: a readable list, nothing that needs one, at 320 px and 200% text.
    await expect(stage.locator('[data-media-controls]')).toBeHidden();
    await expect(stage.locator('[data-read-along-search]')).toBeHidden();
    await expect(stage.locator('.read-along-seek')).toHaveCount(0);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'media header without a script at 320 and 200%', '.media-stage');
    await page.screenshot({
      path: test.info().outputPath('media-header-320-200-no-js-nl.png'),
      fullPage: true,
    });
    return;
  }

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const [width, height] of [
    [1366, 900],
    [NARROW.width, NARROW.height],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(path('en') + '?t=2');
    // `?t=` marks its line before playback and names the moment to share.
    await expect(lines.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(stage.getByRole('button', { name: 'Share from 0:02' })).toBeVisible();
    await expectNoAxeViolations(page, { label: `media header at ${width}` });
    await page.screenshot({ path: test.info().outputPath(`media-header-${width}-en.png`) });
  }
  await setTextSize(page, '200%');
  await layoutGate(page, 'media header with its controls at 320 and 200%', '.media-stage');
  await expectNoAxeViolations(page, { label: 'media header at 320 and 200%' });
  await page.screenshot({
    path: test.info().outputPath('media-header-320-200-en.png'),
    fullPage: true,
  });
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1366, height: 900 });

  // Search: hits as highlights, a count in a status, Enter to step, Escape to clear.
  const query = stage.getByRole('searchbox', { name: 'Search the transcript' });
  const count = stage.locator('.read-along-count');
  await query.fill('OTTER');
  await expect(count).toHaveText('1 of 1');
  expect(await page.evaluate(() => CSS.highlights.get('read-along-match')?.size)).toBe(1);
  await query.press('Enter');
  await expect(count).toHaveText('1 of 1');
  await query.fill('beaver');
  await expect(count).toHaveText('No matches');
  await query.press('Escape');
  await expect(query).toHaveValue('');
  await expect(count).toHaveText('');

  // A line seeks and plays, starting the player first; the sounding line follows the playback.
  await lines.nth(2).getByRole('button').click();
  const video = page.frameLocator('.managed-video-frame').locator('video');
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(4);
  await expect(lines.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(lines.nth(2).getByRole('button')).toBeFocused();

  // Captions under the picture: the track is hidden and its cue is printed below; remembered.
  await stage.getByRole('radio', { name: 'Below' }).check();
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.textTracks[0]?.mode))
    .toBe('hidden');
  await video.evaluate((el: HTMLVideoElement) => {
    el.pause();
    el.currentTime = 2.5;
  });
  await expect(stage.locator('.media-caption-line')).toHaveText('An otter swims.');

  // The reader scrolls the panel: following stops until "back to now".
  await stage.locator('.read-along-lines').dispatchEvent('wheel');
  const back = stage.getByRole('button', { name: 'Back to now' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(back).toBeHidden();

  // A same-page link with a moment jumps without a reload; "share from" copies that moment.
  await page.locator('.rich-text p').evaluate((p) => {
    const link = document.createElement('a');
    link.href = '?t=2';
    link.textContent = 'from 0:02';
    p.append(' ', link);
  });
  const before = page.url();
  await page.getByRole('link', { name: 'from 0:02' }).click();
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
    .toBeGreaterThanOrEqual(2);
  expect(page.url()).toBe(before.replace(/\?t=\d+/, '?t=2'));
  await video.evaluate((el: HTMLVideoElement) => el.pause());
  await stage.getByRole('button', { name: /^Share from / }).click();
  await expect(stage.locator('.media-share-status')).toHaveText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    new RegExp(`/probe/en/articles/${slug}\\?t=[23]$`)
  );

  await page.reload();
  await expect(stage.getByRole('radio', { name: 'Below' })).toBeChecked();
}
