// Feeds and text representations over HTTP: RSS and Atom of the site, a section and a
// person, `?format=md` on a page's own address and `/llms.txt`, as a feed reader, an agent and
// a crawler read them. The adapter-rules scenario (`feed-rule.ts`) covers which rows a feed lists;
// this proves the routes: content types, nosniff, locale from the URL, escaping, the same 404 as
// HTML, and that a restricted, noindex or canonical-elsewhere item is in none of them.
import { expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases, type Invoker, type Principal } from '@mycel/core';
import { tenantId, withInvoker } from '../invoker';

const article = (slug: string, title: string, over: Record<string, unknown> = {}) => ({
  type: 'article' as const,
  defaultLocale: 'nl',
  locales: ['nl', 'en'],
  title: { nl: title, en: `${title} (en)` },
  lead: { nl: `Samenvatting ${slug}.`, en: `Summary ${slug}.` },
  blocks: [],
  ...over,
});

async function publish(
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
}

export async function exerciseFeeds(page: Page) {
  const id = randomUUID().slice(0, 8);
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const section = `rubriek-${id}`;
  const slugs = {
    open: `feed-open-${id}`,
    members: `feed-leden-${id}`,
    hidden: `feed-noindex-${id}`,
    elsewhere: `feed-elders-${id}`,
  };
  // A title with markup and an ampersand: a feed carries it as text, never as markup.
  const title = `Zout & <b>suiker</b> ${id}`;
  await withInvoker(async (invoker) => {
    const { id: sectionId } = await invoker.run(useCases.createSection, principal, {
      slug: section,
      title: { nl: `Rubriek ${id}`, en: `Section ${id}` },
    });
    await publish(invoker, principal, slugs.open, article(slugs.open, title, { sectionId }), [
      'nl',
      'en',
    ]);
    await publish(
      invoker,
      principal,
      slugs.members,
      article(slugs.members, `Geheim ${id}`, { sectionId, access: { level: 'members' } }),
      ['nl']
    );
    await publish(
      invoker,
      principal,
      slugs.hidden,
      article(slugs.hidden, `Verborgen ${id}`, { sectionId, seo: { noindex: true } }),
      ['nl']
    );
    await publish(
      invoker,
      principal,
      slugs.elsewhere,
      article(slugs.elsewhere, `Elders ${id}`, {
        sectionId,
        seo: { canonical: 'https://elders.example/x' },
      }),
      ['nl']
    );
  });
  const read = async (path: string, type: string) => {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toBe(`${type}; charset=utf-8`);
    expect(res.headers()['x-content-type-options'], path).toBe('nosniff');
    return res.text();
  };
  const leftOut = (body: string) => {
    for (const s of [`Geheim ${id}`, `Verborgen ${id}`, `Elders ${id}`])
      expect(body).not.toContain(s);
  };

  // (a) Site, section and person feeds; the locale is the URL's.
  const rss = await read('/probe/feed.xml', 'application/rss+xml');
  expect(rss).toContain(`<title>Zout &amp; &lt;b&gt;suiker&lt;/b&gt; ${id}</title>`);
  expect(rss).toMatch(new RegExp(`<link>https?://[^<]+/articles/${slugs.open}</link>`));
  expect(rss).toContain(`<description>Samenvatting ${slugs.open}.</description>`);
  leftOut(rss);
  const atom = await read(`/probe/en/sections/${section}/feed.atom`, 'application/atom+xml');
  expect(atom).toContain(`<title>Zout &amp; &lt;b&gt;suiker&lt;/b&gt; ${id} (en)</title>`);
  expect(atom).toContain(`Section ${id}</title>`);
  expect(atom).toMatch(new RegExp(`href="https?://[^"]+/en/articles/${slugs.open}"`));
  leftOut(atom);
  await read('/probe/people/e2e-auteur/feed.xml', 'application/rss+xml');
  for (const path of [
    `/probe/sections/onbekend-${id}/feed.xml`,
    `/probe/people/onbekend-${id}/feed.atom`,
    '/probe/feed.json',
  ]) {
    const res = await page.request.get(path);
    expect(res.status(), path).toBe(404);
  }

  // (b) `?format=md`: the HTML's read as Markdown, with the canonical as a Link header; the same
  // 404 for a restricted article and for a locale that was never published.
  const md = await page.request.get(`/probe/articles/${slugs.open}?format=md`);
  expect(md.status()).toBe(200);
  expect(md.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect(md.headers()['link']).toMatch(new RegExp(`/articles/${slugs.open}>; rel="canonical"$`));
  const text = await md.text();
  expect(text.split('\n')[0]).toBe(`# Zout & \\<b\\>suiker\\</b\\> ${id}`);
  expect(text).toContain(`Samenvatting ${slugs.open}.`);
  for (const path of [`/articles/${slugs.members}`, `/en/articles/${slugs.members}`]) {
    const res = await page.request.get(`/probe${path}?format=md`);
    expect(res.status(), path).toBe(404);
    expect(res.headers()['cache-control'], path).toBe('no-store');
    expect(await res.text(), path).not.toContain('Geheim');
  }

  // (c) llms.txt links each public article's Markdown, per locale, and nothing left out above.
  const llms = await read('/probe/llms.txt', 'text/markdown');
  expect(llms).toMatch(/^# /);
  expect(llms).toMatch(new RegExp(`\\(<https?://[^>]+/articles/${slugs.open}\\?format=md>\\)`));
  expect(llms).toMatch(new RegExp(`/en/articles/${slugs.open}\\?format=md>`));
  leftOut(llms);
}
