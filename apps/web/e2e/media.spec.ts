// flow: publish
// Media admin (TODO #10b, brief #56 § C1): an operator uploads an image through the admin's
// multipart form, sees its thumbnail in the library grid and the list, opens its own page with a
// preview and a lightbox, edits its credit, downloads the original, and the site serves a variant
// with immutable caching. Deleting is refused while content uses the image and works once it no
// longer does. Runs without JavaScript and under axe (light and dark) like the other admin specs;
// the UI gate (skill ui-action-layout) checks both pages at 320 CSS px and 200% text.
//
// No content uses media yet (#8b1 writes the usages), so the "in use" fixture goes in through the
// repository as a block tree's save will, as mycel_app under the tenant's RLS.

import { expect, test, type Page } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { ContentDocumentInput, systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from './lib/axe';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { forwarded, login } from './lib/login';
import { onlyA11y } from './lib/project';

const SITE = 'http://probe.localhost:4173';

const FORWARDED = {
  'x-forwarded-proto': 'http',
  'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
};
test.use({ locale: 'nl-NL', extraHTTPHeaders: FORWARDED });

/**
 * A `width` x `height` RGB PNG with a gradient, so the processor has real pixels to render; with
 * `noise` it hardly compresses, for an upload above adapter-node's default body limit.
 */
function png(width: number, height: number, noise = false): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      raw[i] = noise ? Math.random() * 256 : (x * 255) / width;
      raw[i + 1] = noise ? Math.random() * 256 : (y * 255) / height;
      raw[i + 2] = noise ? Math.random() * 256 : 128;
    }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const item = (page: Page, filename: string) =>
  page.locator('article', { has: page.getByRole('heading', { level: 3, name: filename }) });

/** Open the asset's own page from its card in the library. */
async function openDetail(page: Page, filename: string) {
  await item(page, filename).getByRole('link', { name: filename }).click();
  await expect(page.getByRole('heading', { level: 1, name: filename })).toBeVisible();
}

/** Delete from the asset's own page; back on the library, it is gone. */
async function remove(page: Page, id: string, filename: string) {
  await page.goto(`/admin/probe/media/${id}`);
  await page.getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/media\?done=deleted$/);
  await expect(page.getByRole('status')).toContainText('Het bestand is verwijderd');
  await expect(item(page, filename)).toHaveCount(0);
}

async function upload(page: Page, filename: string, buffer = png(400, 300)) {
  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer,
  });
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('status')).toContainText(`${filename} geüpload`);
  const card = item(page, filename);
  await expect(card).toBeVisible();
  await expect(page.getByRole('link', { name: `Gegevens van ${filename} invullen` })).toBeVisible();
  const src = await card.locator('img').getAttribute('src');
  const id = /\/media\/([0-9a-f-]{36})\/thumb$/.exec(src ?? '')?.[1];
  expect(id, `thumbnail src ${src}`).toBeTruthy();
  return { card, id: id! };
}

/** Mark or clear a usage of `mediaId` the way #8b1's save transaction will. */
async function setUsage(mediaId: string, inUse: boolean) {
  const probe = await tenantId();
  await withInvoker((_, uow) =>
    uow.run(systemPrincipal(probe, 'e2e'), (ctx) =>
      ctx.media.replaceUsages(`e2e:${mediaId}`, inUse ? [{ mediaId, blockId: 'b1' }] : [])
    )
  );
}

test('an operator uploads, sees, edits, downloads and deletes an image', async ({
  page,
  request,
}) => {
  await login(page, '/admin/probe');
  await page.getByRole('link', { name: 'Media beheren' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Media' })).toBeVisible();
  // Only the thumbnail enhancement of the file field; the upload works without it.
  expect(await page.locator('script:not([src="/_admin/file-preview.js"])').count()).toBe(0);
  await expectNoAxeViolations(page, { dark: true });

  const filename = `e2e-${test.info().project.name}-${Date.now()}.png`;
  const { card, id } = await upload(page, filename);
  await expect(card.getByText('400 × 300 px')).toBeVisible();
  await expect(card.getByText('op 0 plekken')).toBeVisible();
  const thumb = await page.request.get(`/admin/probe/media/${id}/thumb`);
  expect(thumb.status()).toBe(200);
  expect(thumb.headers()['content-type']).toBe('image/webp');
  await expectNoAxeViolations(page, { dark: true });

  // The same library as a table, the view kept in the URL.
  await page.getByRole('link', { name: 'Lijst' }).click();
  await expect(page).toHaveURL(/view=list/);
  const row = page.getByRole('row', { name: new RegExp(filename) });
  await expect(row.getByRole('cell', { name: '400 × 300 px' })).toBeVisible();
  await expectNoAxeViolations(page, { dark: true });
  await page.getByRole('link', { name: 'Raster' }).click();

  // The site serves a variant on its own hostname, immutable; never the original.
  const variant = await request.get(`${SITE}/media/${id}/w320.webp`);
  expect(variant.status()).toBe(200);
  expect(variant.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get(`${SITE}/media/${id}/original.png`)).status()).toBe(404);

  // Its own page: a preview from the admin's variant route and a lightbox without a script.
  await openDetail(page, filename);
  expect(await page.locator('script').count()).toBe(0);
  const preview = page.getByRole('region', { name: 'Voorbeeld' });
  const src = await preview.locator('img').first().getAttribute('src');
  expect(src).toMatch(new RegExp(`^/admin/probe/media/${id}/variant/w\\d+\\.webp$`));
  expect((await page.request.get(src!)).headers()['cache-control']).toBe('private, max-age=300');
  await preview.getByRole('button', { name: 'Volledig bekijken' }).click();
  const lightbox = page.getByRole('dialog', { name: filename });
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toBeHidden();
  await expect(page.getByText('400 × 300 px')).toBeVisible();
  await expectNoAxeViolations(page, { dark: true });

  // Edit: two credits, a licence and the focal point (folded away), in groups.
  await page.getByLabel('Bijschrift (nl)').fill('Demonstratie op het plein');
  await page.getByLabel('Titel van het werk').fill('Spandoek');
  await page.getByLabel('Maker van het werk').fill('Buurtcomité');
  await page.getByLabel('Fotograaf').fill('A. Fotograaf');
  await page.getByLabel('Licentie').fill('CC BY 4.0');
  await page.locator('summary', { hasText: 'Focuspunt' }).click();
  await page.getByLabel('Horizontaal').fill('0.25');
  await page.getByRole('button', { name: 'Gegevens opslaan' }).click();
  await expect(page.getByRole('status')).toContainText(`Gegevens van ${filename} opgeslagen`);
  await expect(page.getByLabel('Fotograaf')).toHaveValue('A. Fotograaf');
  await expect(page.getByLabel('Maker van het werk')).toHaveValue('Buurtcomité');
  await page.locator('summary', { hasText: 'Focuspunt' }).click();
  await expect(page.getByText('Nu 25% van links')).toBeVisible();
  await expectNoAxeViolations(page, { dark: true });

  // Download original: a signed admin link, with the session; without the signature a 403.
  const href = await page.getByRole('link', { name: 'Origineel downloaden' }).getAttribute('href');
  expect(href).toMatch(new RegExp(`^/admin/probe/media/${id}/original\\?exp=\\d+&sig=`));
  const original = await page.request.get(href!);
  expect(original.status()).toBe(200);
  expect(original.headers()['content-disposition']).toBe(`attachment; filename="${filename}"`);
  expect(original.headers()['cache-control']).toBe('private, no-store');
  expect((await page.request.get(`/admin/probe/media/${id}/original`)).status()).toBe(403);
  expect((await request.get(href!)).status()).toBe(403);

  // In use: delete is refused with the count; once the usage is gone it works.
  await setUsage(id, true);
  await page.goto('/admin/probe/media');
  await expect(item(page, filename).getByText('op 1 plek', { exact: true })).toBeVisible();
  await page.goto(`/admin/probe/media/${id}`);
  await page.getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page.getByRole('alert')).toContainText(`${filename} is in gebruik op 1 plek`);
  await expect(page.getByRole('heading', { level: 1, name: filename })).toBeVisible();
  await expectNoAxeViolations(page, { dark: true });

  await setUsage(id, false);
  await remove(page, id, filename);
  expect((await request.get(`${SITE}/media/${id}/w320.webp`)).status()).toBe(404);
});

/** A page whose latest version shows `mediaId` in an image block, saved as an editor would. */
async function pageUsing(mediaId: string, title: string) {
  const probe = await tenantId();
  return withInvoker(async (invoker) => {
    const created = await invoker.run(useCases.createItem, systemPrincipal(probe, 'e2e'), {
      slug: `media-usage-${Date.now()}`,
      document: ContentDocumentInput.parse({
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: title },
        blocks: [
          {
            type: 'image',
            version: 1,
            props: { mediaId, decorative: false, alt: { nl: 'Een foto' } },
          },
        ],
        access: { level: 'public' },
      }),
    });
    return created.item.id;
  });
}

test('the asset page links the pages whose latest version uses it', async ({ page }) => {
  await login(page, '/admin/probe/media');
  const filename = `used-${test.info().project.name}-${Date.now()}.png`;
  const { id } = await upload(page, filename);
  const title = `Pagina met ${filename}`;
  const itemId = await pageUsing(id, title);
  await page.goto(`/admin/probe/media/${id}`);
  const usedIn = page.locator('.ui-meta > div', { hasText: 'In de laatste versie van' });
  await expect(usedIn.getByRole('link', { name: title })).toHaveAttribute(
    'href',
    `/admin/probe/content/${itemId}`
  );
  await expectNoAxeViolations(page, { dark: true });
});

test('the lightbox shows a large landscape photo whole, on a laptop and a phone', async ({
  page,
}) => {
  onlyA11y('measures the layout with a script');
  await login(page, '/admin/probe/media');
  // A long name wraps the dialog's head over several lines at 200% text (TODO #61).
  const filename = `large-landscape-photo-of-the-square-during-the-demonstration-${Date.now()}.png`;
  const { id } = await upload(page, filename, png(2400, 1600));
  for (const [viewport, text] of [
    [{ width: 1280, height: 720 }, '100%'],
    [{ width: 1280, height: 720 }, '200%'],
    [{ width: 320, height: 700 }, '100%'],
    [{ width: 320, height: 700 }, '200%'],
  ] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`/admin/probe/media/${id}`);
    await setTextSize(page, text);
    await page.locator('[command="show-modal"]').click();
    const fit = await page.getByRole('dialog', { name: filename }).evaluate((dialog) => {
      const img = dialog.querySelector('img')!.getBoundingClientRect();
      const box = dialog.getBoundingClientRect();
      return {
        scrolls: dialog.scrollHeight > dialog.clientHeight + 1,
        inside: img.top >= box.top - 1 && img.bottom <= box.bottom + 1,
      };
    });
    expect(fit, `${viewport.width} px, text ${text}`).toEqual({ scrolls: false, inside: true });
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await remove(page, id, filename);
});

test('a chosen image shows as a thumbnail before it is uploaded', async ({ page }) => {
  onlyA11y('the preview is a JavaScript enhancement');
  await login(page, '/admin/probe/media');
  const filename = `preview-${Date.now()}.png`;
  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer: png(400, 300),
  });
  const preview = page.getByRole('list', { name: 'Voorvertoning van wat je uploadt' });
  await expect(preview.getByRole('img', { name: filename })).toBeVisible();
  await expectNoAxeViolations(page);
});

test('an upload that is not what it says is refused with a reason', async ({ page }) => {
  await login(page, '/admin/probe/media');
  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
  });
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('alert')).toContainText('SVG-bestanden worden niet geaccepteerd');

  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: png(10, 10),
  });
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('alert')).toContainText('niet wat de naam of het type zegt');
  await expectNoAxeViolations(page, { dark: true });
});

test('a media editor can use the library without tenant administration rights', async ({
  page,
  context,
}) => {
  const email = `media-editor-${test.info().project.name}-${Date.now()}@probe.test`;
  await login(page, '/admin/probe');
  const invite = page.locator('form[action="?/invite"]');
  await invite.getByLabel('E-mailadres (verplicht)', { exact: true }).fill(email);
  await invite.getByLabel('media:read', { exact: true }).check();
  await invite.getByLabel('media:write', { exact: true }).check();
  await invite.getByRole('button', { name: 'Uitnodigen' }).click();
  await expect(page.getByRole('status')).toContainText(email);
  try {
    await context.clearCookies();
    await login(page, '/admin/probe/media', email);
    await expect(page.getByRole('heading', { level: 1, name: 'Media' })).toBeVisible();
    const filename = `editor-${Date.now()}.png`;
    const { id } = await upload(page, filename);
    await expectNoAxeViolations(page, { dark: true });
    // Without content:read the page shows the count, never which pages.
    await openDetail(page, filename);
    await expect(page.getByText('In de laatste versie van')).toHaveCount(0);
    await remove(page, id, filename);
  } finally {
    await context.clearCookies();
    await login(page, '/admin/probe');
    const member = page.locator('form', { has: page.getByRole('heading', { name: email }) });
    await member.locator('button[formaction="?/remove"]').click();
    await expect(page.getByRole('status')).toContainText('Lid verwijderd');
  }
});

test('a body above 512K is refused, except for the media upload', async ({ page, request }) => {
  const big = await request.post(`${SITE}/signup`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
    data: `email=${'a'.repeat(600 * 1024)}`,
  });
  expect(big.status()).toBe(413);

  // No Content-Length: Node writes Transfer-Encoding: chunked. This used to slip past the
  // hook's header-only limit after uploads raised the process-wide ceiling to 26M.
  const chunkedStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(
      'http://127.0.0.1:4173/signup',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: SITE,
          host: 'probe.localhost:4173',
          'x-forwarded-proto': 'http',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }
    );
    req.on('error', reject);
    req.write(`email=${'a'.repeat(300 * 1024)}`);
    req.end('a'.repeat(300 * 1024));
  });
  expect(chunkedStatus).toBe(413);

  const update = await request.post(`/admin/probe/media/${crypto.randomUUID()}?/update`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:4173',
    },
    data: `caption.nl=${'a'.repeat(600 * 1024)}`,
  });
  expect(update.status()).toBe(413);

  await login(page, '/admin/probe/media');
  const buffer = png(600, 600, true);
  expect(buffer.length).toBeGreaterThan(1024 * 1024);
  const filename = `big-${test.info().project.name}-${Date.now()}.png`;
  const { id } = await upload(page, filename, buffer);
  await remove(page, id, filename);
});

/** Upload two or more files in one go on the media page; returns their ids by filename. */
async function uploadMany(page: Page, filenames: string[]) {
  await page
    .getByLabel('Bestanden (verplicht)', { exact: true })
    .setInputFiles(
      filenames.map((name) => ({ name, mimeType: 'image/png', buffer: png(400, 300) }))
    );
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('status')).toContainText(`${filenames.length} bestanden geüpload`);
  const ids: Record<string, string> = {};
  for (const name of filenames) {
    const src = await item(page, name).locator('img').getAttribute('src');
    ids[name] = /\/media\/([0-9a-f-]{36})\/thumb$/.exec(src ?? '')![1]!;
  }
  return ids;
}

test('the library takes several files at once and finds one by name or caption', async ({
  page,
}) => {
  await login(page, '/admin/probe/media');
  const stamp = `${test.info().project.name}-${Date.now()}`;
  const names = [`plein-${stamp}.png`, `optocht-${stamp}.png`];
  const ids = await uploadMany(page, names);
  await expectNoAxeViolations(page, { dark: true });

  await page.getByLabel('Zoeken in media').fill(`plein-${stamp}`);
  await page.getByRole('button', { name: 'Zoeken' }).click();
  await expect(page).toHaveURL(new RegExp(`q=plein-${stamp}`));
  await expect(item(page, names[0]!)).toBeVisible();
  await expect(item(page, names[1]!)).toHaveCount(0);

  // A caption is searched too, and the list view keeps the search.
  await page.goto(`/admin/probe/media/${ids[names[1]!]}`);
  await page.getByLabel('Bijschrift (nl)').fill(`Lange stoet ${stamp}`);
  await page.getByRole('button', { name: 'Gegevens opslaan' }).click();
  await page.goto(`/admin/probe/media?q=${encodeURIComponent(`stoet ${stamp}`)}`);
  await expect(item(page, names[1]!)).toBeVisible();
  await page.getByRole('link', { name: 'Lijst' }).click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page.getByRole('row', { name: new RegExp(names[1]!) })).toBeVisible();
  await page.goto(`/admin/probe/media?q=niets-${stamp}`);
  await expect(page.getByText(`Niets gevonden voor “niets-${stamp}”.`)).toBeVisible();

  for (const name of names) await remove(page, ids[name]!, name);
});

test('an image block chooses its image from a grid of thumbnails, without a script', async ({
  page,
}) => {
  await login(page, '/admin/probe/media');
  const stamp = `${test.info().project.name}-${Date.now()}`;
  const names = [`eerst-${stamp}.png`, `daarna-${stamp}.png`];
  const ids = await uploadMany(page, names);
  const itemId = await pageUsing(ids[names[0]!]!, `Kiezer ${stamp}`);
  await page.goto(`/admin/probe/content/${itemId}`);
  const block = page.locator('details.block').first();
  await block.locator(':scope > summary').click();
  const picker = block.getByRole('group', { name: 'Afbeelding' });
  await expect(picker.locator('[data-picker-name]')).toHaveText(names[0]!);

  await picker.getByRole('button', { name: 'Ander beeld kiezen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Afbeelding' });
  await expect(dialog).toBeVisible();
  // Thumbnails, each a radio named by its file; the current one is checked.
  await expect(dialog.getByRole('radio', { name: names[0]! })).toBeChecked();
  await expect(dialog.locator(`img[src$="/media/${ids[names[0]!]}/thumb"]`)).toBeVisible();
  await expectNoAxeViolations(page, { dark: true });
  await dialog.getByRole('radio', { name: names[1]! }).check();
  await dialog.getByRole('button', { name: 'Klaar' }).click();
  await expect(dialog).toBeHidden();

  await block.getByRole('button', { name: 'Blok opslaan' }).click();
  await expect(page.getByRole('status')).toContainText('Blok opgeslagen.');
  await expect(
    page.locator('details.block').first().getByRole('group', { name: 'Afbeelding' })
  ).toContainText(names[1]!);
});

test('a page gets its featured image from the picker, and shares it when published', async ({
  page,
  request,
}) => {
  await login(page, '/admin/probe/media');
  const stamp = `${test.info().project.name}-${Date.now()}`;
  const filename = `uitgelicht-${stamp}.png`;
  const { id } = await upload(page, filename);
  const slug = `uitgelicht-${stamp}`.toLowerCase();
  const probe = await tenantId();
  const itemId = await withInvoker(async (invoker) => {
    const created = await invoker.run(useCases.createItem, systemPrincipal(probe, 'e2e'), {
      slug,
      document: ContentDocumentInput.parse({
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: `Uitgelicht ${stamp}` },
        blocks: [],
      }),
    });
    return created.item.id;
  });
  await page.goto(`/admin/probe/content/${itemId}`);
  const picker = page.getByRole('group', { name: 'Uitgelicht beeld' });
  await expect(picker.locator('[data-picker-name]')).toHaveText('Nog geen beeld gekozen');
  await picker.getByRole('button', { name: 'Beeld kiezen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Uitgelicht beeld' });
  await dialog.getByRole('radio', { name: filename }).check();
  await dialog.getByRole('button', { name: 'Klaar' }).click();
  // Publishing from the same form saves the choice first (editor trial 2026-10-28).
  await page.getByRole('button', { name: 'Publiceren (nl)' }).click();
  await expect(page.getByRole('status')).toContainText('Gepubliceerd in nl.');
  await expect(page.getByRole('group', { name: 'Uitgelicht beeld' })).toContainText(filename);
  await expectNoAxeViolations(page);

  // No share image of its own: the featured image is the one a share preview shows.
  const html = await (await request.get(`${SITE}/${slug}`)).text();
  const meta = (key: string) =>
    new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];
  expect(meta('og:image')).toBe(`${SITE}/media/${id}/w400.webp`);
  expect([meta('og:image:width'), meta('og:image:height')]).toEqual(['400', '300']);
  expect(meta('og:title')).toBe(`Uitgelicht ${stamp}`);
  expect(meta('og:url')).toBe(`${SITE}/${slug}`);
  expect(meta('twitter:card')).toBe('summary_large_image');
  expect((await request.get(`${SITE}/media/${id}/w400.webp`)).status()).toBe(200);

  // The published page uses the image: the library refuses to delete it.
  await page.goto(`/admin/probe/media/${id}`);
  await page.getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page.getByRole('alert')).toContainText(`${filename} is in gebruik`);
});

test('the picker searches, and uploads dropped files with progress', async ({ page }) => {
  onlyA11y('search and upload are a JavaScript enhancement');
  await login(page, '/admin/probe/media');
  const stamp = `${Date.now()}`;
  const first = `zoek-${stamp}.png`;
  const { id } = await upload(page, first);
  const itemId = await pageUsing(id, `Zoeken ${stamp}`);
  await page.goto(`/admin/probe/content/${itemId}`);
  const block = page.locator('details.block').first();
  await block.locator(':scope > summary').click();
  await block.getByRole('button', { name: 'Ander beeld kiezen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Afbeelding' });

  // Search: only images whose name or caption matches, from the server.
  await dialog.getByLabel('Zoeken op naam of bijschrift').fill(`zoek-${stamp}`);
  await expect(dialog.getByRole('radio')).toHaveCount(1);
  await expect(dialog.getByRole('radio', { name: first })).toBeChecked();
  await dialog.getByLabel('Zoeken op naam of bijschrift').fill(`niets-${stamp}`);
  await expect(dialog.getByText('Niets gevonden.')).toBeVisible();
  await dialog.getByLabel('Zoeken op naam of bijschrift').fill('');

  // Upload two at once, and a refused one: each gets its own line; the last good one is chosen.
  const added = [`nieuw-a-${stamp}.png`, `nieuw-b-${stamp}.png`];
  await dialog.getByLabel('Nieuwe beelden: sleep ze hierheen of kies bestanden').setInputFiles([
    ...added.map((name) => ({ name, mimeType: 'image/png', buffer: png(400, 300) })),
    {
      name: `logo-${stamp}.svg`,
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    },
  ]);
  for (const name of added)
    await expect(dialog.getByText(`${name} geüpload en gekozen.`)).toBeVisible();
  await expect(dialog.getByText(`logo-${stamp}.svg: SVG-bestanden`)).toBeVisible();
  await expect(dialog.getByRole('radio', { name: added[1]! })).toBeChecked();
  await expectNoAxeViolations(page);
  await dialog.getByRole('button', { name: 'Klaar' }).click();
  const picker = block.getByRole('group', { name: 'Afbeelding' });
  await expect(picker.locator('[data-picker-name]')).toHaveText(added[1]!);
  await expect(picker.locator('[data-picker-img]')).toBeVisible();

  await block.getByRole('button', { name: 'Blok opslaan' }).click();
  await expect(page.getByRole('status')).toContainText('Blok opgeslagen.');
  await expect(
    page.locator('details.block').first().getByRole('group', { name: 'Afbeelding' })
  ).toContainText(added[1]!);
});

test.describe('UI gate: the media pages at 320 CSS px and 200% text', () => {
  test.use({ viewport: NARROW });

  for (const locale of ['nl-NL', 'en-GB'])
    for (const text of TEXT_SIZES) {
      test(`every control whole and no horizontal scroll, ${locale}, text ${text}`, async ({
        page,
      }) => {
        onlyA11y('measures the layout with a script');
        await login(page, '/admin/probe/media');
        const filename = `gate-${locale}-${text.replace('%', '')}-${Date.now()}.png`;
        const { id } = await upload(page, filename);
        const headers = forwarded();
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': locale });
        for (const path of ['/admin/probe/media', '/admin/probe/media?view=list']) {
          await page.goto(path);
          await setTextSize(page, text);
          await layoutGate(page, path);
        }
        await page.goto(`/admin/probe/media/${id}`);
        await setTextSize(page, text);
        await page.locator('.ui-fold > summary').click();
        await layoutGate(page, 'detail');
        await page.locator('[command="show-modal"]').click();
        await layoutGate(page, 'lightbox');
        await page.keyboard.press('Escape');
        // The picker on an edit page; its image stays, a page uses it.
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': 'nl-NL' });
        await page.goto('/admin/probe/media');
        const used = await upload(page, `kiezer-${Date.now()}.png`);
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': locale });
        const itemId = await pageUsing(used.id, `Gate ${filename}`);
        await page.goto(`/admin/probe/content/${itemId}`);
        await setTextSize(page, text);
        await layoutGate(page, 'featured image picker', '#featuredImageId');
        await page.locator('#featuredImageId [command="show-modal"]').click();
        await layoutGate(page, 'featured image dialog', 'dialog[open]');
        await page.keyboard.press('Escape');
        await page.locator('details.block > summary').first().click();
        await layoutGate(page, 'media picker', 'details.block');
        await page.locator('details.block [command="show-modal"]').first().click();
        await layoutGate(page, 'media picker dialog', 'dialog[open]');
        await page.keyboard.press('Escape');
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': 'nl-NL' });
        await remove(page, id, filename);
      });
    }
});
