// A restricted article over HTTP (ADR 016 rule 3, ADR 018 rules 6 to 8), on the site's own
// hostname where the reader cookie lives: a visitor gets the teaser and the gate, a signed-in
// reader without the tier the same teaser, a reader with a grant the whole article, and the
// teaser again the moment the grant ends inside the open session. Every hidden place carries a
// sentinel, read in the HTML, the Markdown and the JSON read route; the caching headers are
// those a shared cache would act on. A restricted image behind the boundary reaches the reader
// with access only, through a signed path that ends with the grant. The core matrix is access/projection.test.ts. The spec
// brings the sign-in (it owns the mail spool); the fixtures are made here.

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { callApi, requireApi } from '../api';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from '../layout';

const SITE = 'http://probe.localhost:4173';
const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=600';
const HIDDEN = ['SENTINEL-BODY', 'SENTINEL-CORRECTION', 'SENTINEL-EN', 'sentinel-author@'];
const GRANT_SECONDS = 6;

const text = (t: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
});

async function fixtures(request: APIRequestContext, id: string) {
  // Over the API: its unit of work has the image processor, the e2e invoker has none.
  const photo = await callApi<{ id: string }>(request, 'media.upload', {
    ...useCases.uploadMedia.examples[0]!.input,
    filename: `besloten-${id}.png`,
    access: 'restricted',
  });
  const principal = systemPrincipal(await tenantId(), 'e2e');
  return withInvoker(async (invoker) => {
    const tier = await invoker.run(useCases.createAccessTier, principal, {
      slug: `e2e-tier-${id}`,
      name: { nl: 'Donateurs', en: 'Donors' },
    });
    const author = await invoker.run(useCases.createPerson, principal, {
      slug: `e2e-auteur-${id}`,
      name: 'Sam Schrijver',
      email: `sentinel-author@${id}.example.org`,
    });
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug: `besloten-${id}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `Besloten stuk ${id}`, en: 'SENTINEL-EN title' },
        lead: { nl: 'De lead mag iedereen lezen.', en: 'SENTINEL-EN lead' },
        authorIds: [author.id],
        corrections: [
          { date: '2026-11-01', text: { nl: 'SENTINEL-CORRECTION', en: 'SENTINEL-EN' } },
        ],
        blocks: [
          {
            type: 'rich-text',
            version: 1,
            props: { content: { nl: text('Open alinea voor iedereen.'), en: text('SENTINEL-EN') } },
          },
          { type: 'paywall', version: 1, props: {} },
          {
            type: 'rich-text',
            version: 1,
            props: {
              content: { nl: text('SENTINEL-BODY achter de grens.'), en: text('SENTINEL-EN') },
            },
          },
          {
            type: 'image',
            version: 1,
            props: { mediaId: photo.id, decorative: false, alt: { nl: 'Besloten foto' } },
          },
        ],
        access: { level: 'tier', tierIds: [tier.id], teaser: 'marker' },
      } as never,
    });
    // Only `nl` goes live: the English draft shares the revision and must stay inside.
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    return { tierId: tier.id, slug: item.slug, itemId: item.id, photoId: photo.id };
  });
}

/** A comp grant on the tier for the supporter of `email`, ending `seconds` from now. */
async function grant(email: string, tierId: string, seconds: number) {
  const principal = systemPrincipal(await tenantId(), 'e2e');
  await withInvoker(async (invoker) => {
    const supporter = await invoker.run(useCases.getSupporter, principal, { email });
    await invoker.run(useCases.createAccessGrant, principal, {
      supporterId: supporter.id,
      tierId,
      kind: 'comp',
      reason: 'e2e',
      until: new Date(Date.now() + seconds * 1000).toISOString(),
    });
  });
}

const leaks = (body: string) => HIDDEN.filter((s) => body.includes(s));

export async function exerciseRestrictedArticle(
  page: Page,
  request: APIRequestContext,
  email: string,
  /** Fills in the sign-in form the page is on and follows the mailed link to its one button. */
  signIn: (email: string) => Promise<void>
) {
  const { tierId, slug, itemId, photoId } = await fixtures(request, randomUUID().slice(0, 8));
  const path = `/articles/${slug}`;
  const url = `${SITE}${path}`;
  const gate = page.locator('.reader-gate');

  // A visitor: the teaser, publicly cacheable under its own key, varying on the cookie.
  const anonymous = await request.get(url);
  const teaser = await anonymous.text();
  const etag = anonymous.headers()['etag']!;
  expect(anonymous.status()).toBe(200);
  expect(anonymous.headers()['cache-control']).toBe(PUBLIC_CACHE);
  expect(anonymous.headers()['vary']?.toLowerCase()).toContain('cookie');
  expect(etag).toMatch(/:nl:teaser:/);
  expect(teaser).toContain('Open alinea voor iedereen.');
  expect(leaks(teaser)).toEqual([]);
  expect(teaser).not.toContain(photoId);
  expect((await request.get(url, { headers: { 'if-none-match': etag } })).status()).toBe(304);
  expect(teaser).toMatch(
    /"isAccessibleForFree":false,"hasPart":\{[^}]*"cssSelector":"\.reader-gate"/
  );

  const markdown = await request.get(`${url}?format=md`);
  const md = await markdown.text();
  expect(markdown.headers()['cache-control']).toBe(PUBLIC_CACHE);
  expect(markdown.headers()['vary']?.toLowerCase()).toContain('cookie');
  expect(md).toContain('Open alinea voor iedereen.');
  expect(md).toContain(`${SITE}/reader?return=${encodeURIComponent(path)}`);
  expect(leaks(md)).toEqual([]);

  const json = await request.get(`${requireApi()}/v1/sites/probe/content/article/${slug}`);
  const item = await json.text();
  expect(JSON.parse(item)).toMatchObject({ gate: { prompt: 'signin' }, corrections: [] });
  expect(JSON.parse(item).blocks).toHaveLength(1);
  expect(leaks(item)).toEqual([]);

  await page.goto(url);
  await expect(gate.getByRole('heading', { name: 'Log in om verder te lezen' })).toBeVisible();
  await expectNoAxeViolations(page);
  // The gate at 320 CSS px, also with the largest text: the whole label, nothing cut or overflowing.
  const wide = page.viewportSize()!;
  await page.setViewportSize(NARROW);
  for (const size of TEXT_SIZES) {
    await setTextSize(page, size);
    await layoutGate(page, `reader gate at 320px / ${size}`, 'main');
  }
  await gate.screenshot({ path: test.info().outputPath('reader-gate-320-200.png') });
  await setTextSize(page, '16px');
  await page.setViewportSize(wide);

  // The gate leads to the sign-in page and back to the article; without a grant the reader
  // gets the same teaser, as theirs alone: no validator, no shared cache.
  await gate.getByRole('link', { name: 'Inloggen' }).click();
  await signIn(email);
  await expect(page).toHaveURL(url);
  await expect(
    gate.getByRole('heading', { name: 'Je toegang geldt niet voor dit stuk' })
  ).toBeVisible();
  await expect(gate.getByRole('link')).toHaveCount(0);
  expect(leaks(await page.content())).toEqual([]);
  await expectNoAxeViolations(page);

  // With a standing grant: the whole article, never a 304 on the teaser's validator.
  await grant(email, tierId, GRANT_SECONDS);
  const granted = Date.now();
  const whole = await page.goto(url);
  await expect(page.getByText('SENTINEL-BODY achter de grens.')).toBeVisible();
  await expect(gate).toHaveCount(0);
  expect(whole?.headers()['cache-control']).toBe('private, no-store');
  expect(whole?.headers()['vary']?.toLowerCase()).toContain('cookie');
  expect(whole?.headers()['etag']).toBeUndefined();
  // The corrections come with the body, in their own section after it; the unpublished
  // translation and the author's address stay inside for a reader too.
  const corrections = page.getByRole('region', { name: 'Correcties' });
  await expect(corrections.getByRole('listitem')).toHaveText(
    '1 november 2026: SENTINEL-CORRECTION'
  );
  expect(leaks(await page.content())).toEqual(['SENTINEL-BODY', 'SENTINEL-CORRECTION']);
  await expectNoAxeViolations(page);
  const revalidated = await page.request.get(url, { headers: { 'if-none-match': etag } });
  expect(revalidated.status()).toBe(200);
  expect(await revalidated.text()).toContain('SENTINEL-BODY');
  const readerMd = await page.request.get(`${url}?format=md`);
  expect(await readerMd.text()).toContain('SENTINEL-BODY');
  expect(await readerMd.text()).toContain('- 1 november 2026: SENTINEL-CORRECTION');
  expect(readerMd.headers()['cache-control']).toBe('private, no-store');
  expect(readerMd.headers()['etag']).toBeUndefined();
  // The restricted image: a path signed for this tenant, item and locale, only on this page.
  const photo = page.getByRole('img', { name: 'Besloten foto' });
  await expect(photo).toBeVisible();
  const src = new URL((await photo.getAttribute('src'))!, SITE);
  expect(src.pathname).toMatch(new RegExp(`^/media/${photoId}/`));
  expect(src.searchParams.get('for')).toMatch(new RegExp(`/${itemId}/nl$`));
  const signedImage = await page.request.get(src.href);
  expect(signedImage.status()).toBe(200);
  expect(signedImage.headers()['cache-control']).toBe('private, no-store');
  expect((await request.get(`${SITE}${src.pathname}`)).status()).toBe(403);
  const forged = new URL(src);
  forged.searchParams.set('sig', 'x');
  expect((await request.get(forged.href)).status()).toBe(403);
  // Meanwhile a request without the cookie is still a visitor's.
  const visitorPage = await (await request.get(url)).text();
  expect(leaks(visitorPage)).toEqual([]);
  expect(visitorPage).not.toContain(photoId);

  // The grant ends while the session stays open: the next read is the teaser again.
  await page.waitForTimeout(Math.max(0, granted + GRANT_SECONDS * 1000 + 500 - Date.now()));
  await page.goto(url);
  await expect(
    gate.getByRole('heading', { name: 'Je toegang geldt niet voor dit stuk' })
  ).toBeVisible();
  expect(leaks(await page.content())).toEqual([]);
  expect(await page.content()).not.toContain(photoId);
  // The path handed out while the grant stood ended with it.
  expect((await request.get(src.href)).status()).toBe(403);
}
