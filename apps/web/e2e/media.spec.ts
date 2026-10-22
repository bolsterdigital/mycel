// Media admin (TODO #10b): an operator uploads an image through the admin's multipart form, sees
// its thumbnail in the library, edits its credit, downloads the original, and the site serves a
// variant with immutable caching. Deleting is refused while content uses the image and works
// once it no longer does. Runs without JavaScript and under axe like the other admin specs; the
// UI gate (skill ui-action-layout) checks the asset's action group at 320 CSS px and 200% text.
//
// No content uses media yet (#8b1 writes the usages), so the "in use" fixture goes in through the
// repository as a block tree's save will, as mycel_app under the tenant's RLS.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SITE = 'http://probe.localhost:4173';

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/\//g, '\\/')}$`));
}

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

async function upload(page: Page, filename: string, buffer = png(400, 300)) {
  await page.getByLabel('Bestand', { exact: true }).setInputFiles({
    name: filename,
    mimeType: 'image/png',
    buffer,
  });
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('status')).toContainText(`${filename} geüpload`);
  const card = item(page, filename);
  await expect(card).toBeVisible();
  const src = await card.locator('img').getAttribute('src');
  const id = /\/media\/([0-9a-f-]{36})\/thumb$/.exec(src ?? '')?.[1];
  expect(id, `thumbnail src ${src}`).toBeTruthy();
  return { card, id: id! };
}

/** Mark or clear a usage of `mediaId` the way #8b1's save transaction will. */
async function setUsage(mediaId: string, inUse: boolean) {
  const { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } =
    await import('@mycel/db');
  const { systemPrincipal } = await import('@mycel/core');
  const { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } =
    await import('@mycel/core/testing');
  const operatorDb = createDb(process.env['DATABASE_URL']!);
  const appDb = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const probe = await createTenantDirectory(operatorDb).findBySlug('probe');
    const uow = createUnitOfWork(appDb, {
      clock: { now: () => new Date() },
      ids: uuidv7Ids,
      signer: new FakeSigner(),
      inputHasher: new FakeInputHasher(),
      dns: new FakeDns(),
      platform: memoryPlatform,
    });
    await uow.run(systemPrincipal(probe!.id, 'e2e'), (ctx) =>
      ctx.media.replaceUsages(`e2e:${mediaId}`, inUse ? [{ mediaId, blockId: 'b1' }] : [])
    );
  } finally {
    await Promise.all([operatorDb.destroy(), appDb.destroy()]);
  }
}

test('an operator uploads, sees, edits, downloads and deletes an image', async ({
  page,
  request,
}) => {
  await login(page, 'e2e-admin@probe.test', '/admin/probe');
  await page.getByRole('link', { name: 'Media beheren' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Media' })).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);
  await expectNoAxeViolations(page);

  const filename = `e2e-${test.info().project.name}-${Date.now()}.png`;
  const { card, id } = await upload(page, filename);
  await expect(card.getByText('400 × 300 px')).toBeVisible();
  await expect(card.getByText('op 0 plekken')).toBeVisible();
  const thumb = await page.request.get(`/admin/probe/media/${id}/thumb`);
  expect(thumb.status()).toBe(200);
  expect(thumb.headers()['content-type']).toBe('image/webp');
  await expectNoAxeViolations(page);

  // The site serves a variant on its own hostname, immutable; never the original.
  const variant = await request.get(`${SITE}/media/${id}/w320.webp`);
  expect(variant.status()).toBe(200);
  expect(variant.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect((await request.get(`${SITE}/media/${id}/original.png`)).status()).toBe(404);

  // Edit: two credits, a licence and the focal point, through the native <details> form.
  await card.getByText('Gegevens bewerken').click();
  await card.getByLabel('Bijschrift (nl)').fill('Demonstratie op het plein');
  await card.getByLabel('Titel van het werk').fill('Spandoek');
  await card.getByLabel('Maker van het werk').fill('Buurtcomité');
  await card.getByLabel('Fotograaf').fill('A. Fotograaf');
  await card.getByLabel('Licentie').fill('CC BY 4.0');
  await card.getByLabel('Horizontaal').fill('0.25');
  await card.getByRole('button', { name: 'Gegevens opslaan' }).click();
  await expect(page.getByRole('status')).toContainText(`Gegevens van ${filename} opgeslagen`);
  await item(page, filename).getByText('Gegevens bewerken').click();
  await expect(item(page, filename).getByLabel('Fotograaf')).toHaveValue('A. Fotograaf');
  await expect(item(page, filename).getByLabel('Maker van het werk')).toHaveValue('Buurtcomité');
  await expect(item(page, filename).getByText('Nu 25% van links')).toBeVisible();
  await expectNoAxeViolations(page);

  // Download original: a signed admin link, with the session; without the signature a 403.
  const href = await item(page, filename)
    .getByRole('link', { name: 'Origineel downloaden' })
    .getAttribute('href');
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
  await item(page, filename).getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page.getByRole('alert')).toContainText(`${filename} is in gebruik op 1 plek`);
  await expect(item(page, filename)).toBeVisible();
  await expectNoAxeViolations(page);

  await setUsage(id, false);
  await page.goto('/admin/probe/media');
  await item(page, filename).getByRole('button', { name: 'Verwijderen' }).click();
  await expect(page.getByRole('status')).toContainText(`${filename} verwijderd`);
  await expect(item(page, filename)).toHaveCount(0);
  expect((await request.get(`${SITE}/media/${id}/w320.webp`)).status()).toBe(404);
});

test('an upload that is not what it says is refused with a reason', async ({ page }) => {
  await login(page, 'e2e-admin@probe.test', '/admin/probe/media');
  await page.getByLabel('Bestand', { exact: true }).setInputFiles({
    name: 'logo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
  });
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('alert')).toContainText('SVG-bestanden worden niet geaccepteerd');

  await page.getByLabel('Bestand', { exact: true }).setInputFiles({
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: png(10, 10),
  });
  await page.getByRole('button', { name: 'Uploaden' }).click();
  await expect(page.getByRole('alert')).toContainText('niet wat de naam of het type zegt');
  await expectNoAxeViolations(page);
});

test('a media editor can use the library without tenant administration rights', async ({
  page,
  context,
}) => {
  const email = `media-editor-${test.info().project.name}-${Date.now()}@probe.test`;
  await login(page, 'e2e-admin@probe.test', '/admin/probe');
  const invite = page.locator('form[action="?/invite"]');
  await invite.getByLabel('E-mailadres', { exact: true }).fill(email);
  await invite.getByLabel('media:read', { exact: true }).check();
  await invite.getByLabel('media:write', { exact: true }).check();
  await invite.getByRole('button', { name: 'Uitnodigen' }).click();
  await expect(page.getByRole('status')).toContainText(email);
  try {
    await context.clearCookies();
    await login(page, email, '/admin/probe/media');
    await expect(page.getByRole('heading', { level: 1, name: 'Media' })).toBeVisible();
    const filename = `editor-${Date.now()}.png`;
    const { card } = await upload(page, filename);
    await expectNoAxeViolations(page);
    await card.getByRole('button', { name: 'Verwijderen' }).click();
    await expect(item(page, filename)).toHaveCount(0);
  } finally {
    await context.clearCookies();
    await login(page, 'e2e-admin@probe.test', '/admin/probe');
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

  const update = await request.post('/admin/probe/media?/update', {
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'http://127.0.0.1:4173',
    },
    data: `caption.nl=${'a'.repeat(600 * 1024)}`,
  });
  expect(update.status()).toBe(413);

  await login(page, 'e2e-admin@probe.test', '/admin/probe/media');
  const buffer = png(600, 600, true);
  expect(buffer.length).toBeGreaterThan(1024 * 1024);
  const filename = `big-${test.info().project.name}-${Date.now()}.png`;
  const { card } = await upload(page, filename, buffer);
  await card.getByRole('button', { name: 'Verwijderen' }).click();
  await expect(item(page, filename)).toHaveCount(0);
});

test.describe('UI gate: the media action group at 320 CSS px and 200% text', () => {
  test.use({ viewport: { width: 320, height: 900 } });

  for (const text of ['100%', '200%']) {
    test(`every control whole and no horizontal scroll, text ${text}`, async ({ page }) => {
      test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
      await login(page, 'e2e-admin@probe.test', '/admin/probe/media');
      const filename = `gate-${text.replace('%', '')}-${Date.now()}.png`;
      const { card } = await upload(page, filename);
      await card.getByText('Gegevens bewerken').click();
      if (text !== '100%') await page.addStyleTag({ content: `html { font-size: ${text}; }` });
      const problems = await page.evaluate(() => {
        const out: string[] = [];
        const width = document.documentElement.clientWidth;
        if (document.documentElement.scrollWidth > width) {
          out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
          for (const el of document.querySelectorAll('body *'))
            if (el.getBoundingClientRect().right > width + 1 && el.children.length === 0)
              out.push(
                `past the edge: <${el.tagName.toLowerCase()}> ${el.textContent?.trim().slice(0, 40)}`
              );
        }
        for (const b of document.querySelectorAll('button, a.button, summary')) {
          const r = b.getBoundingClientRect();
          const label = b.textContent?.trim() ?? '';
          if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${label}`);
          if (r.right > width + 1 || r.left < -1) out.push(`outside the viewport: ${label}`);
          if (r.height < 44 || r.width < 44) out.push(`tap target under 44px: ${label}`);
        }
        // A label or legend that runs past its card is clipped too, even when the page does not
        // scroll (a radio's label at 200% text did).
        for (const l of document.querySelectorAll('.card label, .card legend, .card summary')) {
          const card = l.closest('.card')!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(l);
          if (range.getBoundingClientRect().right > card.right + 1)
            out.push(`past its card: ${l.textContent?.trim()}`);
        }
        return out;
      });
      await card.screenshot({
        path: test.info().outputPath(`media-320-${text.replace('%', '')}.png`),
      });
      expect(problems).toEqual([]);
      await card.getByRole('button', { name: 'Verwijderen' }).click();
      await expect(item(page, filename)).toHaveCount(0);
    });
  }
});
