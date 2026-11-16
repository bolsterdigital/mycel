// An editor starts an article as a photo story (ADR 012 rule 8): chosen without photos, the form
// comes back with one sentence and the photo slots instead of a 500; with two of the site's photos
// and their descriptions it makes the article, and the editor shows the image blocks with the alt
// text that was typed. Runs in `no-js` (native dialog invokers) and `a11y` alike. The caller
// uploads the photos, through the real form, so they sit in the server's own blob store.
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { callApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';

/** Pick `filename` in the picker of photo `n` (1-based), through its dialog. */
async function pick(page: Page, n: number, filename: string) {
  const picker = page.getByRole('group', { name: `Foto ${n}` });
  await picker.getByRole('button', { name: 'Beeld kiezen' }).click();
  const dialog = page.getByRole('dialog', { name: `Foto ${n}` });
  await dialog.getByRole('radio', { name: filename }).check();
  await dialog.getByRole('button', { name: 'Klaar' }).click();
}

/** Starts the article from `files` (two photos); `onCreated` gets its id as soon as it exists. */
export async function startPhotoStory(
  page: Page,
  request: APIRequestContext,
  files: readonly [string, string],
  onCreated: (itemId: string) => void
): Promise<void> {
  await page.goto('/admin/probe/content/new?type=article');
  await page.getByLabel('Titel (nl)').fill('Op het plein');
  await page.getByLabel('Titel (en)').fill('On the square');
  await page.getByLabel('Begin met een patroon').selectOption({ label: 'Fotoverhaal' });
  const create = page.getByRole('button', { name: 'Concept maken' });
  await create.click();
  await expect(page.getByRole('alert')).toContainText('Een fotoverhaal begint met foto’s');
  await expect(page.getByLabel('Begin met een patroon')).toHaveValue('standard:photo-story');
  await expect(page.getByLabel('Titel (en)')).toHaveValue('On the square');
  await expectNoAxeViolations(page);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'photo slots', 'main');
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1280, height: 800 });

  // A chosen photo without a description in English is one sentence too.
  await pick(page, 1, files[0]);
  await page.locator('#photo-0-alt-nl').fill('Mensen op het plein');
  await create.click();
  await expect(page.getByRole('alert')).toContainText('Beschrijf elke gekozen foto');
  await expect(page.locator('#photo-0-alt-nl')).toHaveValue('Mensen op het plein');

  await page.locator('#photo-0-alt-en').fill('People on the square');
  await pick(page, 2, files[1]);
  await page.locator('#photo-1-alt-nl').fill('Een spandoek');
  await page.locator('#photo-1-alt-en').fill('A banner');
  await create.click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  const itemId = page.url().split('/').at(-1)!;
  onCreated(itemId);
  // Each image block's card shows the photo with the description that was typed.
  for (const alt of ['Mensen op het plein', 'Een spandoek'])
    await expect(
      page.getByRole('figure', { name: `Beschrijving (alt-tekst) ${alt}` })
    ).toBeVisible();
  for (const file of files) await expect(page.getByText(file).first()).toBeAttached();

  const { blocks } = (await callApi(request, 'content.item.get', { itemId })).revision.document;
  expect(blocks.map((b: { type: string }) => b.type).join()).toBe(
    'image,rich-text,image,rich-text'
  );
  expect(blocks[0].props).toMatchObject({
    alt: { nl: 'Mensen op het plein', en: 'People on the square' },
    layout: 'full',
  });
  expect(blocks[2].props).toMatchObject({ alt: { nl: 'Een spandoek', en: 'A banner' } });
}
