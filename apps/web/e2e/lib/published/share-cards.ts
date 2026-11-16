// Share images over HTTP, as a link preview and a feed reader see them: a published
// article gets a generated card from the worker, named in the head with its size, type and alt
// and served as an immutable PNG; each locale has its own; a guessed or withdrawn card is a 404;
// an own share image is used exactly, with its own alt; and every content page links the site's
// feeds in its language. The core suite (`share-card.test.ts`) proves pruning, the theme walk and
// tenant isolation; this proves the routes and the real renderer behind the worker.
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi } from '../api';
import { tenantId, withInvoker } from '../invoker';

const article = (title: string, over: Record<string, unknown> = {}) => ({
  type: 'article' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: title, en: `${title} (en)` },
  blocks: [],
  ...over,
});

export async function exerciseShareCards(page: Page) {
  const id = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const carded = `deelkaart-${id}`;
  const own = `eigen-beeld-${id}`;
  // Through the API: the e2e invoker has no image processor.
  const image = await callApi(page.request, 'media.upload', {
    ...useCases.uploadMedia.examples[0]!.input,
    filename: `deel-${id}.png`,
  });
  const ids = await withInvoker(async (invoker) => {
    const out: Record<string, string> = {};
    for (const [slug, doc] of [
      [carded, article(`Kaart ${id}`)],
      [
        own,
        article(`Eigen ${id}`, {
          seo: { imageId: image.id, imageAlt: { nl: `Beschrijving ${id}`, en: `Described ${id}` } },
        }),
      ],
    ] as const) {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug,
        document: doc as never,
      });
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, principal, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
      out[slug] = item.id;
    }
    return out;
  });

  const head = async (path: string) => {
    await page.goto(path);
    const meta = (property: string) =>
      page.locator(`meta[property="${property}"]`).getAttribute('content');
    return {
      image: await meta('og:image'),
      width: await meta('og:image:width'),
      height: await meta('og:image:height'),
      type: await meta('og:image:type'),
      alt: await meta('og:image:alt'),
      twitter: await page.locator('meta[name="twitter:card"]').getAttribute('content'),
    };
  };

  // (a) The worker draws the card after publication; until then the head shows no card.
  const card = (path: string) =>
    expect
      .poll(async () => (await head(path)).image, { timeout: 20_000, message: path })
      .toMatch(/\/_share\/[0-9a-f-]{36}\/(nl|en)\/[0-9a-f]{24}\.png$/);
  await card(`/probe/articles/${carded}`);
  const nl = await head(`/probe/articles/${carded}`);
  expect(nl).toMatchObject({
    width: '1200',
    height: '630',
    type: 'image/png',
    alt: `Kaart ${id}`,
    twitter: 'summary_large_image',
  });
  await card(`/probe/en/articles/${carded}`);
  const en = await head(`/probe/en/articles/${carded}`);
  expect(en.image).not.toBe(nl.image);
  expect(en.alt).toBe(`Kaart ${id} (en)`);

  // (b) The card itself: an immutable PNG; any other fingerprint is a 404.
  const path = new URL(nl.image!).pathname;
  const res = await page.request.get(path);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/png');
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect(res.headers()['cache-control']).toBe('public, max-age=31536000, immutable');
  expect([...(await res.body()).subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const guessed = path.replace(/[0-9a-f]{24}\.png$/, `${'0'.repeat(24)}.png`);
  expect((await page.request.get(guessed)).status()).toBe(404);

  // (c) Unpublished, the card is gone from its address too.
  await withInvoker((invoker) =>
    invoker.run(useCases.unpublishItem, principal, { itemId: ids[carded]!, locale: 'nl' })
  );
  const gone = await page.request.get(path);
  expect(gone.status()).toBe(404);
  expect(gone.headers()['cache-control']).toBe('no-store');

  // (d) An own share image is used exactly, with its own alt per locale, and gets no card.
  const exact = await head(`/probe/articles/${own}`);
  expect(exact.image).toContain(`/media/${image.id}/`);
  expect(exact.image).not.toContain('/_share/');
  expect(exact.alt).toBe(`Beschrijving ${id}`);
  expect((await head(`/probe/en/articles/${own}`)).alt).toBe(`Described ${id}`);

  // (e) Every content page links the site's feeds in its own language.
  const feeds = async (path: string) => {
    await page.goto(path);
    return page
      .locator('link[rel="alternate"][type^="application/"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute('href')));
  };
  expect(await feeds(`/probe/articles/${own}`)).toEqual(['/probe/feed.xml', '/probe/feed.atom']);
  expect(await feeds(`/probe/en/articles/${own}`)).toEqual([
    '/probe/en/feed.xml',
    '/probe/en/feed.atom',
  ]);
  const person = await feeds('/probe/people/e2e-auteur');
  expect(person).toEqual([
    '/probe/feed.xml',
    '/probe/feed.atom',
    '/probe/people/e2e-auteur/feed.xml',
    '/probe/people/e2e-auteur/feed.atom',
  ]);
}
