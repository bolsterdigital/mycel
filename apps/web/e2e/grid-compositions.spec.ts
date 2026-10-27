// Composition coverage uses real published documents and the existing preview renderer.
// Rejected: standalone HTML fixtures that drift from production blocks.
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test';
import {
  Invoker,
  buildRegistry,
  systemPrincipal,
  useCases,
  type ContentDocument,
} from '@mycel/core';
import { FakeDns, FakeInputHasher, FakeSigner, memoryPlatform } from '@mycel/core/testing';
import { createDb, createTenantDirectory, createUnitOfWork, uuidv7Ids } from '@mycel/db';

const compositions = [
  { slug: 'grid-information-v1', type: 'page', title: 'Samen zorgen voor de buurt' },
  { slug: 'campagne', type: 'page', title: 'Schone lucht, nu' },
  { slug: 'quality-article-v3', type: 'article', title: 'De straat die ruimte maakt' },
];

async function call(request: APIRequestContext, name: string, data: unknown) {
  const response = await request.post(`${process.env['E2E_API_URL']}/v1/${name}`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

async function item(request: APIRequestContext, entry: (typeof compositions)[number]) {
  const { items } = await call(request, 'content.item.list', {
    type: entry.type,
    slug: entry.slug,
  });
  expect(items).toHaveLength(1);
  return call(request, 'content.item.get', { itemId: items[0].id });
}

test.use({ locale: 'nl-NL', extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

test.beforeAll(async ({ request }) => {
  test.skip(test.info().project.name !== 'a11y', 'composition measurements run in a11y');
  // The third composition adds ordinary information prose around existing, resolved media.
  // Reuse synthetic assets and references, never upload or contact an external provider.
  const { items } = await call(request, 'content.item.list', {
    type: 'page',
    slug: compositions[0]!.slug,
  });

  const source = await item(request, compositions[1]!);
  const doc: ContentDocument = structuredClone(source.revision.document);
  doc.title = { nl: compositions[0]!.title, en: 'Caring for the neighbourhood together' };
  doc.blocks = doc.blocks.filter((block) => !['hero', 'form'].includes(block.type));
  const prose = doc.blocks.find((block) => block.type === 'rich-text')!;
  doc.blocks.push({ ...structuredClone(prose), id: 'information-closing' });
  const created = items.length
    ? await item(request, compositions[0]!)
    : await call(request, 'content.item.create', {
        slug: compositions[0]!.slug,
        document: doc,
      });
  const owner = createDb(process.env['DATABASE_URL']!);
  const app = createDb(process.env['APP_DATABASE_URL']!);
  try {
    const probe = await createTenantDirectory(owner).findBySlug('probe');
    if (!probe) throw new Error('probe tenant missing');
    const invoker = new Invoker(
      buildRegistry(),
      createUnitOfWork(app, {
        clock: { now: () => new Date() },
        ids: uuidv7Ids,
        signer: new FakeSigner(),
        inputHasher: new FakeInputHasher(process.env['AUDIT_HASH_KEY']),
        dns: new FakeDns(),
        platform: memoryPlatform,
      })
    );
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, systemPrincipal(probe.id, 'e2e'), {
        itemId: created.item.id,
        revisionId: created.revision.id,
        locale,
      });
  } finally {
    await app.destroy();
    await owner.destroy();
  }
});

async function metrics(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, width: r.width, bottom: r.bottom, top: r.top };
    };
    return {
      viewport: document.documentElement.clientWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
      font: getComputedStyle(document.body).fontFamily,
      fontSize: getComputedStyle(document.body).fontSize,
      measure: getComputedStyle(document.querySelector('.page')!).getPropertyValue(
        '--content-width'
      ),
      prose: box('.page .rich-text'),
      wide: box('.page .layout-wide'),
      full: box('.page .layout-full'),
      title: box('.page h1'),
      floats: [...document.querySelectorAll('.page [class*="layout-float-"]')].map(
        (el) => getComputedStyle(el).float
      ),
    };
  });
}

for (const entry of compositions)
  for (const width of [320, 768, 1440])
    test(`${entry.slug}: composition at ${width}px`, async ({ page }) => {
      test.skip(test.info().project.name !== 'a11y', 'DOM measurements');
      await page.setViewportSize({ width, height: 900 });
      const path = `/probe/${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`;
      expect((await page.goto(path))?.status()).toBe(200);
      await expect(page.locator('main h1')).toHaveText(entry.title);
      const measured = await metrics(page);
      await test
        .info()
        .attach('rails.json', { body: JSON.stringify(measured), contentType: 'application/json' });
      console.log(entry.slug, width, JSON.stringify(measured));
      expect(measured.overflow).toBe(false);
      if (measured.full) expect(measured.full.width).toBe(width);
      if (width === 1440 && measured.wide) expect(measured.wide.width).toBe(1088);
      expect(measured.title!.width).toBeCloseTo(measured.prose!.width, 0);
      if (width === 1440) {
        expect(measured.prose!.width).toBeGreaterThanOrEqual(680);
        expect(measured.prose!.width).toBeLessThanOrEqual(740);
      }
      await page.screenshot({
        path: test.info().outputPath(`${entry.slug}-${width}.png`),
        fullPage: true,
      });
    });

for (const entry of compositions)
  test(`${entry.slug}: saved and live preview share the public rails`, async ({
    page,
    request,
  }) => {
    test.skip(test.info().project.name !== 'a11y', 'live preview is an enhancement');
    await page.setViewportSize({ width: 1440, height: 1000 });
    const saved = await item(request, entry);
    await page.context().setExtraHTTPHeaders({
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `2001:db8:46::${Math.floor(Math.random() * 0xffff).toString(16)}`,
    });
    await page.goto(`/admin/probe/content/${saved.item.id}`);
    await page.getByLabel('E-mail').fill('e2e-admin@probe.test');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(new RegExp(`/content/${saved.item.id}$`));
    const edit = page.url();
    const href = await page.getByRole('link', { name: /Voorbeeld \(nl\)/ }).getAttribute('href');
    await page.goto(href!);
    const savedMetrics = await metrics(page);
    expect(savedMetrics.overflow).toBe(false);
    expect(savedMetrics.prose!.width).toBeGreaterThanOrEqual(680);
    expect(savedMetrics.title!.width).toBeCloseTo(savedMetrics.prose!.width, 0);
    await page.goto(edit);
    if (entry.type === 'article') {
      // The article writer has no automatic live-preview panel yet. Exercise the real
      // unsaved-document route with the unchanged native metadata form; this proves the
      // renderer, not a missing writer interaction (which remains owned by #11).
      await page.locator('[data-live-preview-source]').evaluate((node, id) => {
        const form = node as HTMLFormElement;
        form.action = '/admin/probe/preview/draft';
        for (const [name, value] of [
          ['itemId', id],
          ['previewLocale', 'nl'],
        ]) {
          const input = document.createElement('input');
          input.name = name!;
          input.value = value!;
          form.append(input);
        }
        form.submit();
      }, saved.item.id);
      await expect(page.locator('main h1')).toHaveText(entry.title);
      const draft = await metrics(page);
      expect(draft.overflow).toBe(false);
      expect(draft.prose!.width).toBeCloseTo(savedMetrics.prose!.width, 0);
      await test.info().attach('article-draft-rails.json', {
        body: JSON.stringify({ saved: savedMetrics, draft, writerLivePanel: 'not-implemented' }),
        contentType: 'application/json',
      });
      return;
    }
    const frame = page.frameLocator('[data-live-preview-frame]');
    await expect(frame.locator('main h1')).toHaveText(entry.title);
    // The real editor gives the iframe a narrower container than the monitor. Its own
    // viewport, rather than the parent admin viewport, determines the public rails.
    const live = await frame.locator('main').evaluate((main) => {
      const width = main.ownerDocument.documentElement.clientWidth;
      const prose = main.querySelector('.rich-text')!.getBoundingClientRect();
      const title = main.querySelector('h1')!.getBoundingClientRect();
      return {
        width,
        prose: prose.width,
        title: title.width,
        overflow: main.ownerDocument.documentElement.scrollWidth > width + 1,
      };
    });
    expect(live.overflow).toBe(false);
    expect(live.title).toBeCloseTo(live.prose, 0);
    await test.info().attach('preview-rails.json', {
      body: JSON.stringify({ saved: savedMetrics, live }),
      contentType: 'application/json',
    });
    await page.screenshot({
      path: test.info().outputPath(`${entry.slug}-live.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: live.width, height: 900 });
    await page.goto(`/probe/${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`);
    expect((await metrics(page)).prose!.width).toBeCloseTo(live.prose, 0);
  });

test('a narrow composition on a wide monitor contains floats and full media', async ({ page }) => {
  test.skip(test.info().project.name !== 'a11y', 'DOM measurements');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/probe/articles/quality-article-v3');
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('.page { max-width: 400px; margin-inline: auto; }');
    document.adoptedStyleSheets.push(sheet);
  });
  const measured = await metrics(page);
  expect(measured.floats).toEqual(['none', 'none']);
  expect(measured.full!.width).toBe(400);
  expect(measured.prose!.width).toBeGreaterThan(360);
  expect(measured.prose!.width).toBeLessThanOrEqual(368);
  expect(measured.overflow).toBe(false);
});

// Chrome's tabs API changes actual desktop browser zoom. Pinch/pageScaleFactor and a larger
// root font cannot prove this: assert the halved CSS viewport and doubled pixel ratio too.
test('real Chromium 200% browser zoom reflows the composition', async () => {
  test.skip(test.info().project.name !== 'a11y', 'browser zoom measurement');
  const directory = await mkdtemp(join(tmpdir(), 'mycel-zoom-'));
  let context;
  try {
    await writeFile(
      join(directory, 'manifest.json'),
      JSON.stringify({
        manifest_version: 3,
        name: 'Mycel layout measurement',
        version: '1.0',
        permissions: ['tabs'],
        background: { service_worker: 'worker.js' },
      })
    );
    await writeFile(
      join(directory, 'worker.js'),
      'chrome.runtime.onInstalled.addListener(() => {});'
    );
    context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      viewport: null,
      args: [
        `--disable-extensions-except=${directory}`,
        `--load-extension=${directory}`,
        '--window-size=1440,1000',
      ],
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4173/probe/articles/quality-article-v3');
    const before = await page.evaluate(() => ({ width: innerWidth, ratio: devicePixelRatio }));
    await worker.evaluate(async () => {
      // chrome is provided by this measurement extension, not by application code.
      const api = (
        globalThis as unknown as {
          chrome: {
            tabs: {
              query: (q: object) => Promise<{ id: number; url: string }[]>;
              setZoom: (id: number, factor: number) => Promise<void>;
            };
          };
        }
      ).chrome;
      const tab = (await api.tabs.query({})).find((tab) => tab.url.includes('/probe/articles/'))!;
      await api.tabs.setZoom(tab.id, 2);
    });
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(before.ratio * 2);
    const after = await metrics(page);
    expect(after.viewport).toBeCloseTo(before.width / 2, 0);
    expect(after.overflow).toBe(false);
    expect(after.title!.width).toBeCloseTo(after.prose!.width, 0);
    await writeFile(
      test.info().outputPath('browser-zoom.json'),
      JSON.stringify({ before, after, version: context.browser()?.version() })
    );
    await test.info().attach('browser-zoom.json', {
      body: JSON.stringify({ before, after, version: context.browser()?.version() }),
      contentType: 'application/json',
    });
    await page.screenshot({ path: test.info().outputPath('browser-zoom-200.png'), fullPage: true });
    await page.goto('http://127.0.0.1:4173/probe/blok-faq-accordion-full');
    const faq = await page.evaluate(() => {
      const section = document.querySelector('main > .faq')!.getBoundingClientRect();
      const answer = document.querySelector('.faq .answer')!.getBoundingClientRect();
      return {
        viewport: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
        section: section.width,
        answer: answer.width,
        ratio: devicePixelRatio,
      };
    });
    expect(faq.viewport).toBeCloseTo(before.width / 2, 0);
    expect(faq.ratio).toBe(before.ratio * 2);
    expect(faq.scroll).toBeLessThanOrEqual(faq.viewport + 1);
    expect(faq.section).toBe(faq.viewport);
    expect(faq.answer).toBeLessThanOrEqual(faq.section);
    await page.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.faq details')).toHaveAttribute('open', '');
    await page.screenshot({
      path: test.info().outputPath('faq-browser-zoom-200.png'),
      fullPage: true,
    });
    if (process.env['FAQ_REPORT_DIR']) {
      await mkdir(process.env['FAQ_REPORT_DIR'], { recursive: true });
      await page.screenshot({
        path: join(process.env['FAQ_REPORT_DIR'], 'faq-browser-zoom-200.png'),
        fullPage: true,
      });
      await writeFile(
        join(process.env['FAQ_REPORT_DIR'], 'faq-browser-zoom.json'),
        JSON.stringify({ faq, version: context.browser()?.version() }, null, 2) + '\n'
      );
    }
    await test.info().attach('faq-browser-zoom.json', {
      body: JSON.stringify({ faq, version: context.browser()?.version() }),
      contentType: 'application/json',
    });
  } finally {
    await context?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const entry of compositions)
  for (const locale of ['nl', 'en'])
    test(`${entry.slug} ${locale}: separate text enlargement and spacing stress`, async ({
      page,
    }) => {
      test.skip(test.info().project.name !== 'a11y', 'DOM measurements');
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(
        `/probe/${locale === 'en' ? 'en/' : ''}${entry.type === 'article' ? 'articles/' : ''}${entry.slug}`
      );
      for (const spacing of [false, true]) {
        await page.evaluate((spacing) => {
          document.documentElement.style.fontSize = '200%';
          if (spacing) {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(
              '* { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } p { margin-bottom: 2em !important; }'
            );
            document.adoptedStyleSheets.push(sheet);
          }
        }, spacing);
        expect((await metrics(page)).overflow).toBe(false);
        const clipped = await page.locator('.actions a').evaluateAll((actions) =>
          actions
            .filter((action) => {
              const box = action.getBoundingClientRect();
              return (
                box.width < 44 ||
                box.height < 44 ||
                action.scrollWidth > action.clientWidth + 1 ||
                getComputedStyle(action).textOverflow === 'ellipsis'
              );
            })
            .map((action) => action.textContent)
        );
        expect(clipped).toEqual([]);
      }
    });
