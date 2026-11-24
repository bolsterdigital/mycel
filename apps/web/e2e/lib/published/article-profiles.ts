// The same compact frame must fit an ordinary landscape photo and a focused portrait. Use
// the licensed demo photos through real uploads so the browser exercises responsive sources.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi } from '../api';
import { editorReady, postDraftPreview } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { layoutGate, NARROW, setTextSize } from '../layout';
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
  const second = await createAuthor('-b', { name: 'Noor van den Berg', pagePolicy: 'never' });
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
    if (index) continue;
    const edit = '/admin/probe/content/' + story.item.id;
    await login(page, edit);
    await editorReady(page);
    const profile = page.locator('#articleProfile');
    await profile.focus();
    await profile.press('p');
    await expect(profile).toHaveValue('post');
    await profile.press('ArrowDown');
    await expect(profile).toHaveValue('longread');
    const advanced = page.locator('details.longread');
    await advanced.locator('summary').focus();
    await page.keyboard.press('Enter');
    const header = advanced.locator('[name="profile.longread.header"]');
    await expect(header).toHaveValue('standard');
    await header.selectOption('');
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(
      page,
      'article presentation controls at 320 and 200%',
      '.article-profile-fields'
    );
    if (isA11y())
      await advanced.screenshot({ path: test.info().outputPath('article-profile-controls.png') });
    await setTextSize(page, '100%');
    await postDraftPreview(page, story.item.id);
    await expect(page.locator('.page-cover')).toBeVisible();
  }
}
