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
import { BLOCK_DEFINITIONS, ContentDocumentInput, systemPrincipal, useCases } from '@mycel/core';
import { expectNoAxeViolations } from './lib/axe';
import { expectPixels, watchImages } from './lib/images';
import { asOwner, tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { forwarded, login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { openPublication } from './lib/publication';

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
  await page.getByRole('button', { name: 'Bestand uploaden', exact: true }).click();
  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer,
  });
  await page.getByRole('button', { name: 'Uploaden', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(`${filename} geüpload`);
  const card = item(page, filename);
  await expect(card).toBeVisible();
  await expect(page.getByRole('link', { name: `Gegevens van ${filename} invullen` })).toBeVisible();
  const src = await card.locator('img').getAttribute('src');
  const id = /\/media\/([0-9a-f-]{36})\/thumb$/.exec(src ?? '')?.[1];
  expect(id, `thumbnail src ${src}`).toBeTruthy();
  return { card, id: id! };
}

/**
 * What a test leaves in probe: pages it made and images it uploaded (by id, or by filename for an
 * upload the picker made). Cleared after each test, pass or fail: there is no content
 * delete, and every revision keeps the usages of its images, so a test page would otherwise pin
 * its images and their files in the shared tenant for good, and probe grew by fifteen media a run.
 */
const leftovers = {
  items: [] as string[],
  media: [] as string[],
  names: [] as string[],
  members: [] as string[],
};

test.afterEach(async () => {
  const { items, media, names, members } = leftovers;
  leftovers.items = [];
  leftovers.media = [];
  leftovers.names = [];
  leftovers.members = [];
  if (items.length + media.length + names.length + members.length === 0) return;
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker, uow) => {
    for (const itemId of items) {
      const { revisions } = await invoker.run(useCases.listRevisions, principal, {
        itemId,
        limit: 100,
      });
      await uow.run(principal, async (ctx) => {
        for (const r of revisions) await ctx.media.replaceUsages(`item:${itemId}:rev:${r.id}`, []);
      });
    }
    for (const q of names)
      for (const m of await uow.run(principal, (ctx) => ctx.media.list({ q, limit: 5 })))
        if (m.filename === q) media.push(m.id);
    for (const id of media) await invoker.run(useCases.deleteMedia, principal, { id });
    for (const operatorId of members)
      await invoker.run(useCases.removeMember, principal, { operatorId });
  });
});

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
  await page.getByRole('link', { name: 'Media', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Media' })).toBeVisible();
  // Only the thumbnail enhancement of the file field; the upload works without it.
  expect(
    await page
      .locator(
        'script:not([src="/_admin/file-preview.js"], [src="/_admin/drop-upload.js"], [src="/_admin/nav.js"])'
      )
      .count()
  ).toBe(0);
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
  expect(variant.headers()['cross-origin-resource-policy']).toBe('cross-origin');
  expect(variant.status()).toBe(200);
  expect(variant.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get(`${SITE}/media/${id}/original.png`)).status()).toBe(404);

  // Its own page: a preview from the admin's variant route and a lightbox without a script.
  await openDetail(page, filename);
  expect(await page.locator('script:not([src="/_admin/nav.js"])').count()).toBe(0);
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
    leftovers.items.push(created.item.id);
    return created.item.id;
  });
}

test('the asset page links the pages whose latest version uses it', async ({ page }) => {
  await login(page, '/admin/probe/media');
  const filename = `used-${test.info().project.name}-${Date.now()}.png`;
  const { id } = await upload(page, filename);
  leftovers.media.push(id);
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
  await page.getByRole('button', { name: 'Bestand uploaden', exact: true }).click();
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
  await page.getByRole('button', { name: 'Bestand uploaden', exact: true }).click();
  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
  });
  await page.getByRole('button', { name: 'Uploaden', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('SVG-bestanden worden niet geaccepteerd');

  await page.getByRole('button', { name: 'Bestand uploaden', exact: true }).click();
  await page.getByLabel('Bestanden (verplicht)', { exact: true }).setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: png(10, 10),
  });
  await page.getByRole('button', { name: 'Uploaden', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('niet wat de naam of het type zegt');
  await expectNoAxeViolations(page, { dark: true });
});

test('a media editor can use the library without tenant administration rights', async ({
  page,
  context,
}) => {
  const email = `media-editor-${test.info().project.name}-${Date.now()}@probe.test`;
  await login(page, '/admin/probe/leden');
  await page.getByRole('button', { name: 'Iemand uitnodigen' }).click();
  const invite = page.locator('form[action="?/invite"]');
  await invite.getByLabel('E-mailadres (verplicht)', { exact: true }).fill(email);
  // Media only, no content:read: a custom set in the role picker's advanced part (#101).
  await invite.getByRole('radio', { name: /^Aangepast/ }).check();
  await invite.locator('summary', { hasText: 'Geavanceerd' }).click();
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
    await login(page, '/admin/probe/leden');
    const member = page.getByRole('row', { name: new RegExp(email) });
    await member.locator('summary', { hasText: 'Verwijderen' }).click();
    await member.getByRole('button', { name: `Ja, verwijderen: ${email}` }).click();
    await expect(page.getByRole('status')).toContainText('Uit het team verwijderd');
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
  await page.getByRole('button', { name: 'Bestand uploaden', exact: true }).click();
  await page
    .getByLabel('Bestanden (verplicht)', { exact: true })
    .setInputFiles(
      filenames.map((name) => ({ name, mimeType: 'image/png', buffer: png(400, 300) }))
    );
  await page.getByRole('button', { name: 'Uploaden', exact: true }).click();
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
  await page.getByRole('button', { name: 'Filteren' }).click();
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

// The library as a worklist, on the rules of the content list. With and without a script,
// since every view is a link or a GET form.
test('the library narrows to what needs attention, in any order, and an asset goes back to it', async ({
  page,
}) => {
  await login(page, '/admin/probe/media');
  const stamp = `${test.info().project.name}-${Date.now()}`;
  const names = {
    lacking: `aaa-half-${stamp}.png`,
    described: `bbb-heel-${stamp}.png`,
    unused: `ccc-los-${stamp}.png`,
  };
  const ids = await uploadMany(page, Object.values(names));
  const probe = await tenantId();
  const itemId = await withInvoker(async (invoker) => {
    const { item } = await invoker.run(useCases.createItem, systemPrincipal(probe, 'e2e'), {
      slug: `media-worklist-${Date.now()}`,
      document: ContentDocumentInput.parse({
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `Werklijst ${stamp}` },
        blocks: [
          {
            type: 'image',
            version: 1,
            props: { mediaId: ids[names.lacking], decorative: false, alt: { nl: 'Half' } },
          },
          {
            type: 'image',
            version: 1,
            props: {
              mediaId: ids[names.described],
              decorative: false,
              alt: { nl: 'Heel', en: 'Whole' },
            },
          },
        ],
        access: { level: 'public' },
      }),
    });
    return item.id;
  });
  leftovers.items.push(itemId);
  leftovers.media.push(ids[names.lacking]!, ids[names.described]!);

  await page.goto(`/admin/probe/media?q=${stamp}`);
  await expect(page.locator('#media-count')).toHaveText('3 gevonden');

  // Alt text missing: only the file a use lacks a locale for, and it says what is on.
  await page.getByLabel('Gebruik').selectOption('no-alt');
  await page.getByRole('button', { name: 'Filteren' }).click();
  await expect(page).toHaveURL(/show=no-alt/);
  await expect(page.locator('#media-count')).toHaveText('1 gevonden');
  await expect(item(page, names.lacking)).toBeVisible();
  await expect(item(page, names.described)).toHaveCount(0);
  await expect(item(page, names.unused)).toHaveCount(0);
  await expectNoAxeViolations(page, { dark: true });

  // A chip takes only itself off: the search stays.
  await page.getByRole('link', { name: 'Filter Gebruik: Alt-tekst ontbreekt verwijderen' }).click();
  await expect(page).toHaveURL(new RegExp(`q=${stamp}`));
  await expect(page).not.toHaveURL(/show=/);
  await expect(page.locator('#media-count')).toHaveText('3 gevonden');

  // Unused: what can go, and the delete on its page agrees.
  await page.getByLabel('Gebruik').selectOption('unused');
  await page.getByRole('button', { name: 'Filteren' }).click();
  await expect(item(page, names.unused)).toBeVisible();
  await expect(item(page, names.lacking)).toHaveCount(0);

  // A type is a filter too; nothing of this search is a document, and the empty list says what to do.
  await page.getByLabel('Soort').selectOption('document');
  await page.getByRole('button', { name: 'Filteren' }).click();
  await expect(page.getByText(`Niets gevonden voor “${stamp}”.`)).toBeVisible();
  await page.getByRole('link', { name: 'Filters wissen' }).click();
  await expect(page).not.toHaveURL(/kind=|show=|q=/);

  // An order in the form works in the grid; in the table the headings say and change the same.
  await page.goto(`/admin/probe/media?q=${stamp}`);
  await page.getByLabel('Volgorde').selectOption('name-desc');
  await page.getByRole('button', { name: 'Filteren' }).click();
  await expect(page.locator('article h3').first()).toHaveText(names.unused);
  await page.getByRole('link', { name: 'Lijst' }).click();
  await expect(page).toHaveURL(/view=list/);
  await expect(page).toHaveURL(/sort=name-desc/);
  const table = page.locator('#media-table');
  await expect(table.getByRole('columnheader', { name: 'Bestandsnaam' })).toHaveAttribute(
    'aria-sort',
    'descending'
  );
  await table.getByRole('link', { name: 'Grootte' }).click();
  await expect(page).toHaveURL(/sort=size-asc/);
  await expect(table.getByRole('columnheader', { name: 'Grootte' })).toHaveAttribute(
    'aria-sort',
    'ascending'
  );

  // The moment of the upload is a date a person reads, with the exact one on the element.
  const uploaded = table.getByRole('row', { name: new RegExp(names.described) }).locator('time');
  await expect(uploaded).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
  await expect(uploaded).not.toHaveText(/object/);

  // In and out: the asset goes back to this view, at its own row.
  await table.getByRole('link', { name: names.described }).click();
  await page
    .getByRole('navigation', { name: /kruimel/i })
    .getByRole('link', { name: 'Media' })
    .click();
  await expect(page).toHaveURL(new RegExp(`q=${stamp}.*view=list`));
  await expect(page).toHaveURL(new RegExp(`#media-${ids[names.described]}$`));

  // The menu opens the plain library, and a page past the end lands on the last there is.
  await page.goto(`/admin/probe/media?q=${stamp}&page=9`);
  await expect(page).not.toHaveURL(/page=/);
  await expect(page.locator('#media-count')).toHaveText('3 gevonden');

  // Deleting returns to that view too, and says so.
  await page.goto(`/admin/probe/media/${ids[names.unused]}`);
  await page.getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page).toHaveURL(new RegExp(`q=${stamp}.*done=deleted$`));
  await expect(page.getByRole('status')).toContainText('Het bestand is verwijderd');
  await expect(page.getByRole('link', { name: names.unused })).toHaveCount(0);
});

test('an image block chooses its image from a grid of thumbnails, without a script', async ({
  page,
}) => {
  await login(page, '/admin/probe/media');
  const stamp = `${test.info().project.name}-${Date.now()}`;
  const names = [`eerst-${stamp}.png`, `daarna-${stamp}.png`];
  const ids = await uploadMany(page, names);
  leftovers.media.push(...names.map((n) => ids[n]!));
  const itemId = await pageUsing(ids[names[0]!]!, `Kiezer ${stamp}`);
  await page.goto(`/admin/probe/content/${itemId}`);
  const block = page.locator('details.block').first();
  await block.locator(':scope > summary').click();
  const picker = block.getByRole('group', { name: 'Afbeelding' });
  await expect(picker.locator('[data-picker-name]')).toHaveText(names[0]!);

  await picker.getByRole('button', { name: 'Vervangen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Afbeelding' });
  await expect(dialog).toBeVisible();
  // Thumbnails, each a radio named by its file; the current one is checked.
  await expect(dialog.getByRole('radio', { name: names[0]! })).toBeChecked();
  await expect(dialog.locator(`img[src$="/media/${ids[names[0]!]}/thumb"]`)).toBeVisible();
  await expectNoAxeViolations(page, { dark: true });
  await dialog.getByRole('radio', { name: names[1]! }).check();
  await dialog.getByRole('button', { name: 'Klaar' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
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
  leftovers.media.push(id);
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
    leftovers.items.push(created.item.id);
    return created.item.id;
  });
  await page.goto(`/admin/probe/content/${itemId}`);
  // With JavaScript the picker is on the Featured tab (#86 PR 2).
  const featuredTab = page.locator('#item-tabs-tab-featured');
  if (isA11y()) await featuredTab.click();
  const picker = page.getByRole('group', { name: 'Uitgelicht beeld' });
  await expect(picker.locator('[data-picker-name]')).toHaveText('Nog geen beeld gekozen');
  await picker.getByRole('button', { name: 'Beeld kiezen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Uitgelicht beeld' });
  await dialog.getByRole('radio', { name: filename }).check();
  await dialog.getByRole('button', { name: 'Klaar' }).click();
  // Publishing from the same form saves the choice first (editor trial 2026-10-28).
  await openPublication(page);
  await page.getByRole('button', { name: 'Publiceren', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Gepubliceerd in nl.');
  // Back on the first tab after the redirect: the picker is there, a tab away with JavaScript.
  await expect(page.locator('#featuredImageId')).toContainText(filename);
  await expectNoAxeViolations(page);

  // No share image of its own: the featured image is the one a share preview shows.
  const html = await (await request.get(`${SITE}/${slug}`)).text();
  const meta = (key: string) =>
    new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];
  expect(meta('og:image')).toBe(`${SITE}/media/${id}/w400.webp`);
  // A featured image has no alt to give: alt text belongs to a use, and this use has none.
  expect(meta('og:image:alt')).toBeUndefined();
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

test('an item shows real pixels in its header, picker, blocks and preview', async ({ page }) => {
  // A thumbnail that is in the DOM but has no file behind it looked like a working
  // editor in every earlier spec. Header (hero and featured image), the picker's grid, an image
  // block and a legacy hero block, and the preview each have to decode to a real picture.
  await login(page, '/admin/probe/media');
  const stamp = `${test.info().project.name}-${Date.now()}`;
  const filename = `pixels-${stamp}.png`;
  const { id } = await upload(page, filename);
  leftovers.media.push(id);
  const probe = await tenantId();
  const image = { mediaId: id, decorative: false, alt: { nl: 'Een proefbeeld' } };
  const itemId = await withInvoker(async (invoker) => {
    const created = await invoker.run(useCases.createItem, systemPrincipal(probe, 'e2e'), {
      slug: `pixels-${stamp}`.toLowerCase(),
      document: ContentDocumentInput.parse({
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: `Pixels ${stamp}` },
        heroImageId: id,
        featuredImageId: id,
        blocks: [
          {
            type: 'hero',
            version: BLOCK_DEFINITIONS.hero.version,
            props: { variant: 'cover', title: { nl: 'Kop' }, image, actions: [], align: 'start' },
          },
          { type: 'image', version: BLOCK_DEFINITIONS.image.version, props: image },
        ],
      }),
    });
    leftovers.items.push(created.item.id);
    return created.item.id;
  });

  const images = watchImages(page);
  await page.goto(`/admin/probe/content/${itemId}`);
  await expectPixels(page.locator('.ui-media-picker-current img'), 'header and block pickers');
  await expectPixels(page.locator('.ui-media-option img'), "the picker's grid");
  await expectPixels(page.locator('[class*="ui-block-card"] img'), 'block cards');
  const preview = await page.locator('a[href*="/preview/item/"]').first().getAttribute('href');
  expect(preview, 'a preview link').toBeTruthy();
  await page.goto(preview!);
  await expectPixels(page.locator('main img'), 'preview');
  expect(images.bad()).toEqual([]);
});

test('the picker searches, and uploads dropped files with progress', async ({ page }) => {
  onlyA11y('search and upload are a JavaScript enhancement');
  await login(page, '/admin/probe/media');
  const stamp = `${Date.now()}`;
  const first = `zoek-${stamp}.png`;
  const { id } = await upload(page, first);
  leftovers.media.push(id);
  const itemId = await pageUsing(id, `Zoeken ${stamp}`);
  await page.goto(`/admin/probe/content/${itemId}`);
  const block = page.locator('details.block').first();
  await block.locator(':scope > summary').click();
  await block.getByRole('button', { name: 'Vervangen' }).click();
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
  leftovers.names.push(...added);
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

  await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
  await expect(
    page.locator('details.block').first().getByRole('group', { name: 'Afbeelding' })
  ).toContainText(added[1]!);
});

test('the library opens as a grid and accepts window-wide drops with per-file results', async ({
  page,
}) => {
  onlyA11y('window-wide drag and drop is progressive enhancement');
  await login(page, '/admin/probe/media');
  await expect(page.getByRole('button', { name: 'Bestand uploaden', exact: true })).toBeVisible();
  await expect(page.getByLabel('Bestanden (verplicht)', { exact: true })).toBeHidden();
  const originalUrl = page.url();
  const overlay = page.locator('[data-upload-overlay]');
  // A dragged link is not a file, and crossing nested elements does not hide the overlay.
  await page.evaluate(() => {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/uri-list', 'https://example.test/image.png');
    document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
  });
  await expect(overlay).toBeHidden();
  const enter = () =>
    page.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(['x'], 'photo.png', { type: 'image/png' }));
      document.body.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
      document
        .querySelector('h1')!
        .dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer }));
      document
        .querySelector('h1')!
        .dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer }));
    });
  await enter();
  await expect(overlay).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await enter();
  await expect(overlay).toBeVisible();
  await setTextSize(page, '200%');
  await page.setViewportSize(NARROW);
  await layoutGate(page, 'window-wide file drop');
  await expectNoAxeViolations(page);
  await page.screenshot({ path: '.scratch/media-drop-320-200.png' });
  const stamp = Date.now();
  const filename = `window-drop-${stamp}.png`;
  leftovers.names.push(filename);
  const drop = (files: { name: string; type: string; bytes: number[] }[]) =>
    page.evaluate((uploads) => {
      const dataTransfer = new DataTransfer();
      for (const f of uploads)
        dataTransfer.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      // Body is outside the upload dialog and its native file field.
      document.body.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
      );
    }, files);
  await drop([
    { name: filename, type: 'image/png', bytes: [...png(400, 300)] },
    { name: `refused-${stamp}.svg`, type: 'image/svg+xml', bytes: [...Buffer.from('<svg/>')] },
  ]);
  const results = page.locator('[data-upload-results]');
  await expect(results).toContainText(`${filename} geüpload.`);
  await expect(results).toContainText('SVG-bestanden worden niet geaccepteerd');
  await expect(item(page, filename)).toBeVisible();
  await expect(overlay).toBeHidden();
  expect(page.url()).toBe(originalUrl);
  await layoutGate(page, 'upload results and refreshed grid');
  await expectNoAxeViolations(page);
  await page.screenshot({ path: '.scratch/media-grid-320-200.png' });
  // A network failure stays visible, does not navigate to the file and permits retry.
  await page.route('**/media/upload', (route) => route.abort());
  await drop([{ name: 'network.png', type: 'image/png', bytes: [...png(10, 10)] }]);
  await expect(results).toContainText('network.png: Uploaden mislukt');
  expect(page.url()).toBe(originalUrl);
  await page.unroute('**/media/upload');
  await results.getByRole('button', { name: 'Uploadresultaten sluiten' }).click();
  await expect(results).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(originalUrl);
  // A restricted upload dialog retains the native file drop path. Never publish a file
  // dropped behind that dialog via the public quick-upload endpoint.
  await page.getByRole('button', { name: 'Bestand uploaden', exact: true }).click();
  await page.getByLabel('Afgeschermd: alleen lezers met toegang zien dit bestand').check();
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/media/upload'))
      uploads.push(request.url());
  });
  await drop([{ name: 'restricted.png', type: 'image/png', bytes: [...png(10, 10)] }]);
  await expect(overlay).toBeHidden();
  await expect(page.getByLabel('Bestanden (verplicht)', { exact: true })).toBeVisible();
  expect(uploads).toEqual([]);
  await page.keyboard.press('Escape');
  const bounds = await item(page, filename).boundingBox();
  expect(bounds!.y).toBeLessThan(700);
  await page.screenshot({ path: '.scratch/media-grid-desktop.png' });
});
test.describe('UI gate: the media pages at 320 CSS px and 200% text', () => {
  test.use({ viewport: NARROW });

  for (const locale of ['nl-NL', 'en-GB'])
    for (const text of TEXT_SIZES) {
      test(`every control whole and no horizontal scroll, ${locale}, text ${text}`, async ({
        page,
      }) => {
        onlyA11y('measures the layout with a script');
        const email = `media-layout-${Date.now()}@probe.test`;
        const principal = systemPrincipal(await tenantId(), 'e2e');
        const member = await withInvoker((invoker) =>
          invoker.run(useCases.inviteMember, principal, {
            email,
            capabilities: ['tenant:admin'],
          })
        );
        leftovers.members.push(member.operatorId);
        await login(page, '/admin/probe/media', email);
        const filename = `gate-${locale}-${text.replace('%', '')}-${Date.now()}.png`;
        const { id } = await upload(page, filename);
        const setLocale = (value: string) =>
          asOwner((owner) =>
            owner
              .updateTable('operators')
              .set({ ui_locale: value })
              .where('id', '=', member.operatorId)
              .execute()
          );
        await setLocale(locale.startsWith('en') ? 'en' : 'nl');
        const headers = forwarded();
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': locale });
        // The last with its chips and clear link, in the longest words of the filter bar.
        for (const path of [
          '/admin/probe/media',
          '/admin/probe/media?view=list',
          `/admin/probe/media?view=list&sort=size-asc&q=gate&kind=image&show=no-alt`,
          `/admin/probe/media?view=list&q=${filename}&kind=image&show=unused`,
        ]) {
          await page.goto(path);
          await setTextSize(page, text);
          await layoutGate(page, path);
          await page
            .getByRole('button', {
              name: locale === 'en-GB' ? 'Upload file' : 'Bestand uploaden',
              exact: true,
            })
            .click();
          await layoutGate(page, 'upload dialog', '#media-upload');
          await expectNoAxeViolations(page);
          await page.keyboard.press('Escape');
        }
        await page.goto(`/admin/probe/media/${id}`);
        await setTextSize(page, text);
        await page.locator('.ui-fold > summary').click();
        await layoutGate(page, 'detail');
        await page.locator('[command="show-modal"]').click();
        await layoutGate(page, 'lightbox');
        await page.keyboard.press('Escape');
        // The picker on an edit page; its image stays, a page uses it.
        await setLocale('nl');
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': 'nl-NL' });
        await page.goto('/admin/probe/media');
        const used = await upload(page, `kiezer-${Date.now()}.png`);
        leftovers.media.push(used.id);
        await setLocale(locale.startsWith('en') ? 'en' : 'nl');
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': locale });
        const itemId = await pageUsing(used.id, `Gate ${filename}`);
        await page.goto(`/admin/probe/content/${itemId}`);
        await setTextSize(page, text);
        // Four tabs (#86 PR 2) wrap as whole tabs; with JavaScript the picker is on Featured.
        const tabs = page.locator('#item-tabs [role="tablist"]');
        if (isA11y()) {
          await expect(tabs).toBeVisible();
          await layoutGate(page, 'item tabs', '#item-tabs [role="tablist"]');
          await page.locator('#item-tabs-tab-featured').click();
        }
        await layoutGate(page, 'featured image picker', '#featuredImageId');
        await page.locator('#featuredImageId [command="show-modal"]').click();
        await layoutGate(page, 'featured image dialog', 'dialog[open]');
        await page.keyboard.press('Escape');
        if (isA11y()) await page.locator('#item-tabs-tab-content').click();
        await page.locator('details.block > summary').first().click();
        await layoutGate(page, 'media picker', 'details.block');
        await page.locator('details.block [command="show-modal"]').first().click();
        await layoutGate(page, 'media picker dialog', 'dialog[open]');
        await page.keyboard.press('Escape');
        await setLocale('nl');
        await page.context().setExtraHTTPHeaders({ ...headers, 'accept-language': 'nl-NL' });
        await remove(page, id, filename);
      });
    }
});

// Sound (#185): the browser's own player reads a real MP3 from the site, by byte ranges, because
// Safari plays nothing from a server without them. Without scripts the player and the link remain.
test.describe('a sound file on the site', () => {
  const PATH = '/probe/blok-audio-transcript';

  test('the player, the link and the transcript work without a script', async ({ page }) => {
    await page.goto(PATH);
    const block = page.locator('section.audio');
    await expect(block.locator('audio[controls]')).toHaveAttribute(
      'aria-label',
      'Het gesprek met de raad'
    );
    await expect(block.getByRole('link', { name: 'Download het geluid' })).toBeVisible();
    await block.getByText('Uitgeschreven tekst').click();
    await expect(block.getByText('Goedemorgen.')).toBeVisible();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'sound block at 320 px and 200%');
  });

  test('the browser reads its duration, and a range gets that part', async ({ page, request }) => {
    onlyA11y();
    await page.goto(PATH);
    const audio = page.locator('section.audio audio');
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.duration))
      .toBeGreaterThan(0.5);
    const src = (await audio.getAttribute('src'))!;
    const whole = await request.get(src);
    expect(whole.status()).toBe(200);
    expect(whole.headers()['content-type']).toBe('audio/mpeg');
    expect(whole.headers()['accept-ranges']).toBe('bytes');
    const size = (await whole.body()).length;
    const part = await request.get(src, { headers: { range: 'bytes=0-9' } });
    expect(part.status()).toBe(206);
    expect(part.headers()['content-range']).toBe(`bytes 0-9/${size}`);
    expect((await part.body()).length).toBe(10);
  });
});
