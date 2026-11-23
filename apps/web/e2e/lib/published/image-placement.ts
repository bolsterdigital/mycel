// Prove one portrait in three independently saved uses, against the real server and CSP.
// The fixture is generated here so customer images and their data stay out of the repo.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { systemPrincipal, useCases, type ImagePlacement } from '@mycel/core';
import { callApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { editorReady, reloadsEditor } from '../editor';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

async function portrait() {
  const width = 960;
  const height = 1280;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const face =
        Math.pow((x / width - 0.5) / 0.17, 2) + Math.pow((y / height - 0.265) / 0.105, 2) < 1;
      const eyes =
        face &&
        Math.abs(y / height - 0.278) < 0.008 &&
        Math.abs(Math.abs(x / width - 0.5) - 0.06) < 0.015;
      pixels.set(eyes ? [36, 36, 49] : face ? [226, 166, 122] : [48, 75, 128], (y * width + x) * 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

export async function exerciseImagePlacement(page: Page) {
  test.setTimeout(65_000);
  const slug = `framing-${randomUUID().slice(0, 8)}`;
  const media = await callApi(page.request, 'media.upload', {
    filename: `${slug}.png`,
    contentType: 'image/png',
    bytes: (await portrait()).toString('base64'),
  });
  expect(media.focal.mode).toBe('auto');
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const { pageId, articleId, personId, oldId } = await withInvoker(async (invoker) => {
    const create = (itemSlug: string, document: unknown) =>
      invoker.run(
        useCases.createItem,
        principal,
        useCases.createItem.input.parse({ slug: itemSlug, document })
      );
    const publish = (itemId: string, revisionId: string) =>
      invoker.run(useCases.publishItem, principal, { itemId, revisionId, locale: 'nl' });
    const general = { defaultLocale: 'nl', locales: ['nl'], heroImageId: media.id };
    const article = await create(`${slug}-article`, {
      ...general,
      type: 'article',
      title: { nl: 'Een portret in het overzicht' },
      blocks: [],
      featuredPlacement: {
        mediaId: media.id,
        framing: { mode: 'manual', point: { x: 0.5, y: 0.12 } },
        narrow: { mode: 'full' },
      },
    });
    const person = await invoker.run(useCases.createPerson, principal, {
      slug,
      name: 'Synthetic profile',
      imageId: media.id,
      imagePlacement: {
        mediaId: media.id,
        framing: { mode: 'manual', point: { x: 0.5, y: 0.18 } },
      },
    });
    const created = await create(slug, {
      ...general,
      type: 'page',
      title: { nl: 'Drie kaders' },
      presentation: { header: 'cover' },
      blocks: [
        {
          type: 'people-grid',
          version: 1,
          props: { source: 'selection', people: [{ personId: person.id }] },
        },
        {
          type: 'overview',
          version: 1,
          props: { source: 'selection', pinned: [{ itemId: article.item.id }] },
        },
      ],
    });
    await publish(article.item.id, article.revision.id);
    await publish(created.item.id, created.revision.id);
    return {
      pageId: created.item.id,
      articleId: article.item.id,
      personId: person.id,
      oldId: created.revision.id,
    };
  });
  const edit = `/admin/probe/content/${pageId}`;
  const href = `/probe/${slug}`;
  const cover = page.locator('.page-cover img');
  const card = page.locator('.person-card img');
  const featured = page.locator('.overview-card img');
  const publish = async () =>
    withInvoker(async (invoker) => {
      const item = await invoker.run(useCases.getItem, principal, { itemId: pageId });
      await invoker.run(useCases.publishItem, principal, {
        itemId: pageId,
        revisionId: item.revision.id,
        locale: 'nl',
      });
      return item;
    });
  await login(page, edit, undefined, { 'accept-language': 'nl' });
  await editorReady(page);
  const panel = page.locator('[data-image-placement][data-picker="heroImageId"]');
  await panel.locator(':scope > summary').click();
  const general = panel.locator('[data-placement-slot="framing"]');
  await general.getByRole('radio', { name: /^(Manual|Handmatig)$/ }).check();
  await general
    .getByRole('spinbutton', { name: /^(Vertical position|Verticale positie) / })
    .fill('24');
  const preview = panel.locator('[data-frame-preview="wide"] img');
  if (isA11y()) await expect(preview).toHaveCSS('object-position', '50% 24%');
  await reloadsEditor(page, () =>
    page
      .getByRole('button', { name: /^(Save|Opslaan)$/ })
      .first()
      .click()
  );
  await panel.locator(':scope > summary').click();
  await expect(preview).toHaveCSS('object-position', '50% 24%');

  await page.goto(href);
  await expect(cover).toHaveCSS('object-fit', 'contain');
  const saved = await publish();
  const manual: ImagePlacement = {
    mediaId: media.id,
    framing: { mode: 'manual', point: { x: 0.5, y: 0.24 } },
  };
  expect(saved.revision.document.heroPlacement).toEqual(manual);
  await withInvoker(async (invoker) => {
    const original = await invoker.run(useCases.getItem, principal, {
      itemId: pageId,
      revisionId: oldId,
    });
    expect(original.revision.document.heroPlacement).toBeUndefined();
    const article = await invoker.run(useCases.getItem, principal, { itemId: articleId });
    expect(article.revision.document.featuredPlacement?.framing).toMatchObject({
      mode: 'manual',
      point: { y: 0.12 },
    });
    const person = await invoker.run(useCases.getPerson, principal, { personId });
    expect(person.imagePlacement?.framing).toMatchObject({ mode: 'manual', point: { y: 0.18 } });
  });

  const measurements = [];
  for (const width of [390, 895, 896, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${href}?revision=${saved.revision.id}`);
    await expect(cover).toHaveCSS('object-position', '50% 24%');
    await expect(cover).toHaveCSS('object-fit', 'cover');
    if (width === 1440) {
      const head = await cover.evaluate((img: HTMLImageElement) => {
        const fullHeight = (img.clientWidth * img.naturalHeight) / img.naturalWidth;
        const top = (fullHeight - img.clientHeight) * 0.24;
        const point = (y: number) => (fullHeight * y - top) / img.clientHeight;
        return { crown: point(0.16), eyes: point(0.278), chin: point(0.37) };
      });
      expect(head.crown).toBeGreaterThan(0);
      expect(head.eyes).toBeGreaterThanOrEqual(0.3);
      expect(head.eyes).toBeLessThanOrEqual(0.37);
      expect(head.chin).toBeLessThan(1);
    }
    await expect(card).toHaveCSS('object-position', '50% 18%');
    await expect(featured).toHaveCSS('object-fit', width < 896 ? 'contain' : 'cover');
    await expect(featured).toHaveCSS('object-position', width < 896 ? '50% 50%' : '50% 12%');
    for (const [image, budget] of [
      [cover, width < 896 ? 100_000 : 300_000],
      [card, 60_000],
      [featured, 150_000],
    ] as const) {
      await image.scrollIntoViewIfNeeded();
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);
      const measured = await image.evaluate((img: HTMLImageElement) => ({
        src: img.currentSrc,
        sizes: img.sizes,
        width: img.clientWidth,
        height: img.clientHeight,
        pixels: Number(img.currentSrc.match(/\/w(\d+)\./)?.[1] ?? 0),
        intrinsic: [Number(img.getAttribute('width')), Number(img.getAttribute('height'))],
      }));
      expect(measured.src).toMatch(/\/w\d+\.(avif|webp)$/);
      expect(measured.intrinsic).toEqual([960, 1280]);
      const bytes = (await (await page.request.get(measured.src)).body()).length;
      expect(bytes).toBeLessThan(budget);
      measurements.push({ viewport: width, ...measured, bytes });
    }
  }
  await test.info().attach('crop-image-budgets.json', {
    body: JSON.stringify(measurements),
    contentType: 'application/json',
  });

  for (const locale of ['nl-NL', 'en-GB']) {
    const context = await page
      .context()
      .browser()!
      .newContext({
        locale,
        baseURL: new URL(page.url()).origin,
        viewport: NARROW,
        javaScriptEnabled: isA11y(),
      });
    try {
      const narrow = await context.newPage();
      await login(narrow, edit, undefined, { 'accept-language': locale });
      await editorReady(narrow);
      const scope = '[data-image-placement][data-picker="heroImageId"]';
      const crop = narrow.locator(scope);
      await crop.locator(':scope > summary').click();
      await expect(crop.locator(':scope > summary')).toHaveText(
        locale === 'nl-NL' ? 'Uitsnede' : 'Crop'
      );
      await setTextSize(narrow, '200%');
      await layoutGate(narrow, `image placement ${locale}`, scope);
      const hitAreas = await crop.locator('label:visible').evaluateAll((labels) =>
        labels.map((label) => {
          const { width, height } = label.getBoundingClientRect();
          return { width, height, label: label.textContent?.trim() };
        })
      );
      expect(hitAreas.length).toBeGreaterThan(4);
      expect(hitAreas.filter(({ height, width }) => width < 44 || height < 44)).toEqual([]);
      const fields = crop.locator('[data-placement-slot="framing"]');
      const manual = fields.getByRole('radio', { name: /^(Manual|Handmatig)$/ });
      await manual.focus();
      await expect(manual).toBeFocused();
      await fields.screenshot({ path: test.info().outputPath(`crop-${locale}-320-200.png`) });
      if (isA11y()) await expectNoAxeViolations(narrow);
    } finally {
      await context.close();
    }
  }
  await page.goto(edit);
  await editorReady(page);
  await panel.locator(':scope > summary').click();
  await panel.locator('[data-placement-reset] input').check();
  await reloadsEditor(page, () =>
    page
      .getByRole('button', { name: /^(Save|Opslaan)$/ })
      .first()
      .click()
  );
  const reset = await publish();
  expect(reset.revision.document.heroPlacement).toBeUndefined();
  await page.goto(`${href}?revision=${reset.revision.id}`);
  await expect(cover).toHaveCSS('object-fit', 'contain');
  await expect(card).toHaveCSS('object-position', '50% 18%');
}
