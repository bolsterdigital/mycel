// Published representations over HTTP: the editor's `noindex` and canonical reach the head, the sitemap lists exactly
// the published, indexable locales with the published revision's lastmod, and robots.txt names
// the sitemap on the primary hostname. Core and the adapter-rules scenario cover the list's
// matrix (tenants, order, paging); this proves what a crawler reads. Fixtures are made here.
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases, type Invoker, type Principal } from '@mycel/core';
import { tenantId, withInvoker } from './invoker';
import { requireApi } from './api';

const doc = (slug: string, over: Record<string, unknown> = {}) => ({
  type: 'page' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: `Pagina ${slug}`, en: `Page ${slug}` },
  blocks: [],
  ...over,
});

async function make(
  invoker: Invoker,
  principal: Principal,
  slug: string,
  document: Record<string, unknown>,
  locales: string[]
) {
  const { item, revision } = await invoker.run(useCases.createItem, principal, {
    slug,
    document: document as never,
  });
  for (const locale of locales)
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale,
    });
  return { item, revision };
}

/** The `<url>` entry of a path in a sitemap, or undefined. */
const entry = (sitemap: string, path: string) =>
  sitemap.match(/<url>.*?<\/url>/g)?.find((u) => new RegExp(`<loc>[^<]*${path}</loc>`).test(u));

export async function exercisePublishedRepresentations(page: Page) {
  const id = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const elsewhere = 'https://elders.example/origineel';
  const slugs = {
    hidden: `seo-noindex-${id}`,
    plain: `seo-gewoon-${id}`,
    canonical: `seo-canonical-${id}`,
    draft: `seo-concept-${id}`,
    never: `seo-nooit-${id}`,
    members: `seo-leden-${id}`,
  };
  const draftItem = await withInvoker(async (invoker) => {
    await make(invoker, principal, slugs.hidden, doc(slugs.hidden, { seo: { noindex: true } }), [
      'nl',
    ]);
    await make(invoker, principal, slugs.plain, doc(slugs.plain), ['nl']);
    await make(
      invoker,
      principal,
      slugs.canonical,
      doc(slugs.canonical, { seo: { canonical: elsewhere } }),
      ['nl', 'en']
    );
    await make(invoker, principal, slugs.never, doc(slugs.never), []);
    await make(
      invoker,
      principal,
      slugs.members,
      {
        ...doc(slugs.members, { type: 'article' }),
        title: { nl: `Geheim ${id}`, en: `Secret ${id}` },
        lead: { nl: 'Voor leden.', en: 'For members.' },
        access: { level: 'members' },
      },
      ['nl']
    );
    return make(invoker, principal, slugs.draft, doc(slugs.draft), ['nl']);
  });

  // (a) noindex: in the head and the JSON read route, not in the sitemap; a plain page the reverse.
  await page.goto(`/probe/${slugs.hidden}`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  const json = await page.request.get(
    `${requireApi()}/v1/sites/probe/content/page/${slugs.hidden}`
  );
  expect(json.headers()['x-robots-tag']).toBe('noindex');
  await page.goto(`/probe/${slugs.plain}`);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);

  // (b) An explicit canonical replaces the canonical link and og:url, not the alternates.
  await page.goto(`/probe/en/${slugs.canonical}`);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', elsewhere);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', elsewhere);
  const alternates = await page
    .locator('link[rel="alternate"][hreflang]')
    .evaluateAll((links) => links.map((l) => l.getAttribute('href')));
  expect(alternates).toHaveLength(3);
  for (const href of alternates) expect(href).toMatch(new RegExp(`/${slugs.canonical}$`));

  // (c) The sitemap: published locales with lastmod and alternates; a later draft keeps the
  // published lastmod; an unpublished translation, an unpublished item and noindex are absent;
  // a restricted article is an address without its text; the people are still there.
  // A long-lived development database can outgrow one response: then read the index's parts.
  const read = async (path: string) => {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    return res.text();
  };
  const sitemap = async () => {
    const root = await read('/probe/sitemap.xml');
    if (!root.includes('<sitemapindex')) return root;
    const parts = [...root.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]!).search);
    return (await Promise.all(parts.map((q) => read(`/probe/sitemap.xml${q}`)))).join('');
  };
  const before = await sitemap();
  for (const path of ['/campagne', '/en/campagne', '/articles/bomen-in-de-straat']) {
    const url = entry(before, path);
    expect(url, path).toMatch(/<lastmod>\d{4}-\d\d-\d\dT[^<]+<\/lastmod>/);
    expect(url, path).toContain('hreflang="en"');
    expect(url, path).toContain('hreflang="x-default"');
  }
  expect(entry(before, `/en/articles/bomen-in-de-straat`)).toBeDefined();
  expect(entry(before, `/${slugs.plain}`)).toBeDefined();
  expect(entry(before, `/${slugs.hidden}`)).toBeUndefined();
  expect(entry(before, `/en/${slugs.draft}`)).toBeUndefined();
  expect(entry(before, `/${slugs.never}`)).toBeUndefined();
  expect(entry(before, `/articles/${slugs.members}`)).toBeDefined();
  expect(before).not.toContain(`Geheim ${id}`);
  expect(before).not.toContain('Voor leden.');
  expect((await page.request.get(`/probe/articles/${slugs.members}`)).status()).toBe(404);
  expect(before).toContain('/people/e2e-auteur');
  const lastmod = entry(before, `/${slugs.draft}`)!.match(/<lastmod>([^<]+)</)![1];
  await withInvoker((invoker) =>
    invoker.run(useCases.updateItem, principal, {
      itemId: draftItem.item.id,
      baseRevisionId: draftItem.revision.id,
      document: doc(slugs.draft, { title: { nl: 'Later concept', en: 'Later draft' } }) as never,
    })
  );
  const after = await sitemap();
  expect(entry(after, `/${slugs.draft}`)).toContain(`<lastmod>${lastmod}</lastmod>`);
  expect(after).not.toContain('Later concept');

  // (d) robots.txt on the primary hostname names the absolute sitemap; an alias redirects to it.
  const site = 'probe.localhost:4173';
  const robots = await page.request.get('/robots.txt', { headers: { host: site } });
  expect(robots.status()).toBe(200);
  expect(robots.headers()['content-type']).toContain('text/plain');
  const text = await robots.text();
  expect(text).toMatch(/^Sitemap: https?:\/\/probe\.localhost:4173\/sitemap\.xml$/m);
  expect(text).toMatch(/^Disallow: \/admin$/m);
  expect(text).toMatch(/^Disallow: \/_theme$/m);
  const alias = await page.request.get('/robots.txt', {
    headers: { host: 'e2e-alias.example' },
    maxRedirects: 0,
  });
  expect(alias.status()).toBe(301);
  expect(alias.headers()['location']).toMatch(/\/\/probe\.localhost:4173\/robots\.txt$/);
  const hosted = await page.request.get('/sitemap.xml', { headers: { host: site } });
  expect(await hosted.text()).toMatch(/<loc>https?:\/\/probe\.localhost:4173\/campagne<\/loc>/);
}
