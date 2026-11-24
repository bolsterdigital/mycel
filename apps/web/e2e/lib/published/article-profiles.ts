// The same compact frame must fit an ordinary landscape photo and a focused portrait. Use
// the licensed demo photos through real uploads so the browser exercises responsive sources.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi } from '../api';
import { editorReady, postDraftPreview, reloadsEditor } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { layoutGate, NARROW, setTextSize } from '../layout';
import { openPublication } from '../publication';
import { login } from '../login';
import { isA11y } from '../project';

async function upload(page: Page, name: string) {
  const bytes = await readFile(
    new URL(`../../../../../packages/api/demo-sites/otterdam/${name}.jpg`, import.meta.url)
  );
  return (
    await callApi(page.request, 'media.upload', {
      filename: name + '.jpg',
      contentType: 'image/jpeg',
      bytes: bytes.toString('base64'),
    })
  ).id as string;
}
export async function exerciseArticleProfiles(page: Page) {
  test.setTimeout(120_000);
  const slug = 'profile-' + randomUUID().slice(0, 8);
  const photos = [await upload(page, 'otters-drijven'), await upload(page, 'otter-portret')];
  const createAuthor = (suffix: string, fields: Record<string, string>) =>
    callApi(page.request, 'content.person.create', { slug: slug + suffix, ...fields });
  const first = await createAuthor('-a', {
    name: 'Sam de Vries',
    imageId: photos[1]!,
    pagePolicy: 'always',
  });
  const second = await createAuthor('-b', {
    name: 'Noor van den Berg van Oosterwijk',
    pagePolicy: 'never',
  });
  const principal = systemPrincipal(await tenantId(), 'e2e');
  for (const [index, photo] of photos.entries()) {
    const story = await callApi(page.request, 'content.item.create', {
      slug: slug + index,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Otters in het water', en: 'Otters in the water' },
        lead: { nl: 'Twee otters rusten uit.', en: 'Two otters resting.' },
        heroImageId: photo,
        heroPlacement: {
          mediaId: photo,
          framing: { mode: 'manual', point: { x: 0.5, y: index ? 0.3 : 0.5 } },
        },
        authorIds: index ? [second.id, first.id] : [first.id, second.id],
        blocks: [],
        presentation: { profile: 'longread', overrides: { longread: { header: 'standard' } } },
      },
    });
    for (const locale of ['nl', 'en'])
      await withInvoker((invoker) =>
        invoker.run(useCases.publishItem, principal, {
          itemId: story.item.id,
          revisionId: story.revision.id,
          locale,
        })
      );
    for (const [width, height] of [
      [1024, 740],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/probe/' + (width === 1024 ? '' : 'en/') + 'articles/' + slug + index);
      const img = page.locator('.article-compact img');
      await expect(img).toBeVisible();
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0);
      const box = await img.boundingBox();
      expect(box!.height).toBeCloseTo(height * 0.45, 0);
      expect(box!.width / box!.height).toBeCloseTo(1.5, 2);
      await expect(page.locator('.article-meta')).toContainText(
        width === 1024 ? '1 min lezen' : '1 min read'
      );
      const authors = page.locator('.article-author');
      await expect(authors.locator('img')).toHaveCount(1);
      await expect(authors.locator('a')).toHaveText('Sam de Vries');
      const tops = await authors.evaluateAll((els) =>
        els.map((el) => {
          const range = document.createRange();
          range.selectNodeContents(el.lastElementChild!);
          return range.getBoundingClientRect().top;
        })
      );
      expect(Math.abs(tops[0]! - tops[1]!)).toBeLessThanOrEqual(1);
      if (isA11y())
        await page.screenshot({ path: test.info().outputPath(`profile-${index}-${width}.png`) });
    }
    const locale = index ? 'nl' : 'en';
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'article byline at 200%', '.article-meta');

    const edit = '/admin/probe/content/' + story.item.id;
    await login(page, edit + '?locale=' + locale, undefined, { 'accept-language': locale });
    await editorReady(page);
    const post = page.locator('#articleProfile-post');
    const long = page.locator('#articleProfile-longread');
    await long.focus();
    await page.keyboard.press('ArrowUp');
    await expect(post).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(long).toBeChecked();
    const advanced = page.locator('details.longread');
    await advanced.locator('summary').focus();
    await page.keyboard.press('Enter');
    const header = advanced.locator('[name="profile.longread.header"]');
    await expect(
      advanced.locator('[name="profile.longread.header"][value="standard"]')
    ).toBeChecked();
    await header.first().focus();
    await page.keyboard.press('Space');
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(
      page,
      'article presentation controls at 320 and 200%',
      '.article-profile-fields'
    );
    for (const label of await advanced.locator('.ui-choice label').all()) {
      const box = await label.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }
    if (isA11y())
      await advanced.screenshot({
        path: test.info().outputPath('article-profile-controls-' + locale + '.png'),
      });
    await setTextSize(page, '100%');
    await postDraftPreview(page, story.item.id, 'probe', locale);
    await expect(page.locator('.page-cover')).toBeVisible();
    await page.goto(edit + '?locale=' + locale);
    await editorReady(page);
    await post.focus();
    await page.keyboard.press('Space');
    await reloadsEditor(page, () =>
      page
        .getByRole('button', { name: /^(Save|Opslaan)$/ })
        .first()
        .press('Enter')
    );
    await expect(post).toBeChecked();
    await openPublication(page);
    await page
      .locator('#publication-' + locale)
      .getByRole('button', { name: /^(Publish changes|Wijzigingen publiceren)$/i })
      .press('Enter');
    await page.goto('/probe/' + (locale === 'en' ? 'en/' : '') + 'articles/' + slug + index);
    await expect(page.locator('.article-meta.expanded')).toHaveCount(0);
    await expect(page.locator('.article-compact img')).toBeVisible();
  }
}
