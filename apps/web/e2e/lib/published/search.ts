// The site search page (`/search?q=`) as a visitor uses it: the GET form works without JavaScript,
// the results are what a visitor may read (a title hit first, matches marked, a restricted item by
// its teaser only and labelled "Voor leden", a `noindex` or never published item absent, a later
// draft not searched), the other locale has its own page, and the page is `noindex` and cached
// like content. A reader's search is reader-search.ts. Core and the adapter-rules
// scenario cover the matrix of tenants, locales and revisions; this proves the route. In the
// `a11y` project also axe and the layout gate (320 CSS px, 200% text) with results and with none.
// Fixtures are made here.
import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases, type Invoker, type Principal } from '@mycel/core';
import { expectNoAxeViolations } from '../axe';
import { tenantId, withInvoker } from '../invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';

const para = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function make(
  invoker: Invoker,
  principal: Principal,
  slug: string,
  document: Record<string, unknown>,
  locales: string[]
) {
  const created = await invoker.run(useCases.createItem, principal, {
    slug,
    document: { defaultLocale: 'nl', locales: ['nl', 'en'], blocks: [], ...document } as never,
  });
  for (const locale of locales)
    await invoker.run(useCases.publishItem, principal, {
      itemId: created.item.id,
      revisionId: created.revision.id,
      locale,
    });
  return created;
}

export async function exercisePublicSearch(page: Page) {
  const id = randomUUID().slice(0, 8);
  const word = `zoekproef${id}`;
  const principal = systemPrincipal(await tenantId(), 'e2e');
  const slug = (s: string) => `zoek-${s}-${id}`;
  const sectionSlug = `zoek-${id}`;
  await withInvoker(async (invoker) => {
    const section = await invoker.run(useCases.createSection, principal, {
      slug: sectionSlug,
      title: { nl: `Rubriek ${id}`, en: `Section ${id}` },
    });
    await make(
      invoker,
      principal,
      slug('titel'),
      {
        type: 'page',
        title: { nl: `Over ${word}`, en: `About ${word}` },
        lead: { nl: 'Kort.', en: 'Short.' },
      },
      ['nl', 'en']
    );
    // Published before `tekst`, so it ranks after it: both are body hits, the newest first.
    await make(
      invoker,
      principal,
      slug('leden'),
      {
        type: 'article',
        title: { nl: 'Alleen voor leden' },
        lead: { nl: `Teaser ${word}.` },
        blocks: [
          { type: 'rich-text', version: 1, props: { content: { nl: para('Niet vinden') } } },
        ],
        access: { level: 'members' },
      },
      ['nl']
    );
    const body = `Een langere tekst over de buurt waarin ${word} pas halverwege voorkomt.`;
    const later = await make(
      invoker,
      principal,
      slug('tekst'),
      {
        type: 'article',
        title: { nl: 'Bomen en banken', en: 'Trees' },
        sectionId: section.id,
        blocks: [{ type: 'rich-text', version: 1, props: { content: { nl: para(body) } } }],
      },
      ['nl']
    );
    // A draft saved after publication is not what the visitor reads, so it is not searched.
    await invoker.run(useCases.updateItem, principal, {
      itemId: later.item.id,
      baseRevisionId: later.revision.id,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `Concepttitel ${word}draft`, en: 'Trees' },
        blocks: [],
      } as never,
    });
    const hidden = { title: { nl: `Niet vinden ${word}` }, lead: { nl: `Teaser ${word}.` } };
    await make(
      invoker,
      principal,
      slug('noindex'),
      { type: 'page', ...hidden, seo: { noindex: true } },
      ['nl']
    );
    await make(invoker, principal, slug('concept'), { type: 'page', ...hidden }, []);
  });

  // (a) The form, without JavaScript too: a GET to the path of the locale.
  const empty = await page.goto('/probe/search');
  expect(empty?.status()).toBe(200);
  await expect(page.locator('main h1')).toHaveText('Zoeken');
  await expect(page.locator('main search form[method="get"] input[type="search"]')).toHaveAttribute(
    'maxlength',
    '200'
  );
  await page
    .locator('main')
    .getByRole('searchbox', { name: 'Zoek op deze site' })
    .fill(`  ${word}  `);
  await page.locator('main').getByRole('button', { name: 'Zoeken' }).click();
  await expect(page).toHaveURL(new RegExp(`/probe/search\\?q=\\+*${word}`));

  // (b) Results: the title hit first, the body hits with their match marked, the members' article
  // by its lead with the label; nothing else, and nothing from behind its boundary.
  const res = await page.goto(`/probe/search?q=${word}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toBe('public, max-age=60, stale-while-revalidate=600');
  expect(res?.headers()['x-robots-tag']).toBe('noindex');
  expect(res?.headers()['etag']).toMatch(/^"/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('main h1')).toHaveText(`3 resultaten voor ‘${word}’`);
  const results = page.locator('.search-results > li');
  await expect(results).toHaveCount(3);
  await expect(results.nth(0).locator('h2 a')).toHaveText(`Over ${word}`);
  await expect(results.nth(0).locator('h2 a')).toHaveAttribute('href', `/probe/${slug('titel')}`);
  await expect(results.nth(1).locator('h2 a')).toHaveText('Bomen en banken');
  await expect(results.nth(1).locator('h2 a')).toHaveAttribute(
    'href',
    `/probe/articles/${slug('tekst')}`
  );
  await expect(results.nth(1).locator('mark')).toHaveText(word);
  // Each result is the overview's card (MY-308): its kind, date and access in one line of facts.
  await expect(results.nth(0).locator('.overview-kind')).toHaveText('Pagina');
  await expect(results.nth(1).locator('.overview-kind')).toHaveText(`Rubriek ${id}`);
  await expect(results.nth(1).locator('.overview-date')).toHaveAttribute('datetime', /^\d{4}-/);
  await expect(results.nth(1).locator('.overview-access')).toHaveCount(0);
  await expect(results.nth(2).locator('h2 a')).toHaveText('Alleen voor leden');
  await expect(results.nth(2).locator('.overview-access')).toHaveText('Voor leden');
  await expect(results.nth(2).locator('p mark')).toHaveText(word);
  await expect(page.locator('main')).not.toContainText('Niet vinden');
  await expect(page.locator('main')).not.toContainText('Concepttitel');
  // A replacement pattern in the question is shown as typed, not expanded into the title.
  await page.goto(`/probe/search?${new URLSearchParams({ q: `${word} $&` })}`);
  await expect(page.locator('main h1')).toHaveText(`3 resultaten voor ‘${word} $&’`);
  expect((await page.goto(`/probe/search?q=${word}draft`))?.status()).toBe(200);
  await expect(results).toHaveCount(0);
  await expect(page.locator('.search-empty')).toHaveText(
    'Niets gevonden. Probeer andere of minder woorden.'
  );
  if (isA11y()) await gate(page, 'no results');

  // (c) The English page searches the English text, in English.
  await page.goto(`/probe/en/search?q=${word}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('main h1')).toHaveText(`1 result for “${word}”`);
  await expect(results).toHaveCount(1);
  await expect(results.locator('h2 a')).toHaveAttribute('href', `/probe/en/${slug('titel')}`);

  // (d) Pages a visitor cannot ask for are a 404, not an empty or first page.
  for (const path of [
    `/probe/search?q=${word}&page=0`,
    `/probe/search?q=${word}&page=21`,
    `/probe/search?q=${word}&page=2`,
    '/probe/search?page=2',
    `/probe/nl/search?q=${word}`,
  ])
    expect((await page.request.get(path)).status(), path).toBe(404);

  await exerciseFilters(page, word, sectionSlug, id, slug);

  if (isA11y()) {
    await page.goto(`/probe/search?q=${word}`);
    await gate(page, 'results');
  }
}

/**
 * (e) Filters, count and sort (MY-308 PR 2), as plain links and one GET form, so in both
 * projects: a kind link narrows and says how many, the form adds a section, a period and a sort,
 * an active filter is a link that removes it, nothing found with filters links to the search
 * without them, and a value no visitor can choose is a 404. In `a11y` also the gate on the
 * filtered page, with the filters open.
 */
async function exerciseFilters(
  page: Page,
  word: string,
  sectionSlug: string,
  id: string,
  slug: (s: string) => string
) {
  const results = page.locator('.search-results > li');
  const titles = () => results.locator('h2 a').allTextContents();
  const filters = page.locator('.search-filters');
  await page.goto(`/probe/search?q=${word}`);
  // No filter on: the filters are folded on a narrow screen, so they start closed.
  await expect(filters).not.toHaveAttribute('open');
  const kinds = filters.locator('.search-kinds a');
  await expect(kinds).toHaveText(['Alles (3)', 'Pagina’s (1)', 'Artikelen (2)']);
  await expect(kinds.first()).toHaveAttribute('aria-current', 'true');
  await expect(filters.locator('#search-section option')).toHaveText([
    'Alle rubrieken',
    `Rubriek ${id} (1)`,
  ]);

  // A kind link: one click, the count in the heading, the filter as a removable link.
  await page.setViewportSize({ width: 1366, height: 900 });
  await filters.getByRole('link', { name: 'Artikelen (2)' }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]kind=article(&|$)`));
  await expect(page.locator('main h1')).toHaveText(`2 resultaten voor ‘${word}’`);
  await expect(filters).toHaveAttribute('open');
  expect(await titles()).toEqual(['Bomen en banken', 'Alleen voor leden']);
  await expect(page.locator('.search-chips a')).toHaveText(['Artikelen ×', 'Wis filters']);

  // The form keeps the kind and adds a period and a sort; the newest first.
  await filters.getByLabel('Periode').selectOption('week');
  await filters.getByLabel('Sorteren').selectOption('newest');
  await filters.getByRole('button', { name: 'Toepassen' }).click();
  const url = new URL(page.url());
  expect(Object.fromEntries(url.searchParams)).toEqual({
    q: word,
    kind: 'article',
    section: '',
    period: 'week',
    sort: 'newest',
  });
  expect(await titles()).toEqual(['Bomen en banken', 'Alleen voor leden']);
  await filters.getByLabel('Rubriek').selectOption(sectionSlug);
  await filters.getByRole('button', { name: 'Toepassen' }).click();
  expect(await titles()).toEqual(['Bomen en banken']);
  await expect(page.locator('.search-chips a')).toHaveText([
    'Artikelen ×',
    `Rubriek ${id} ×`,
    'Afgelopen week ×',
    'Wis filters',
  ]);
  if (isA11y()) await gate(page, 'filtered');

  // Removing one filter keeps the others; clearing keeps the question and the sort.
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator('.search-chips').getByRole('link', { name: 'Artikelen', exact: true }).click();
  await expect(page.locator('main h1')).toHaveText(`1 resultaat voor ‘${word}’`);
  expect(new URL(page.url()).searchParams.has('kind')).toBe(false);
  await page.locator('.search-chips').getByRole('link', { name: 'Wis filters' }).click();
  expect(Object.fromEntries(new URL(page.url()).searchParams)).toEqual({ q: word, sort: 'newest' });
  await expect(results).toHaveCount(3);
  await expect(results.first().locator('h2 a')).toHaveAttribute(
    'href',
    `/probe/articles/${slug('tekst')}`
  );

  // Nothing of a kind: say so and link to the same question without filters.
  await page.goto(`/probe/search?q=${word}&kind=media`);
  await expect(results).toHaveCount(0);
  await expect(page.locator('.search-empty')).toContainText('Niets gevonden met deze filters.');
  await page.locator('.search-empty').getByRole('link', { name: 'Zoek zonder filters' }).click();
  await expect(results).toHaveCount(3);

  for (const query of [
    'kind=video',
    'period=day',
    'sort=oldest',
    'section=Nope',
    'section=nergens',
  ])
    expect((await page.request.get(`/probe/search?q=${word}&${query}`)).status(), query).toBe(404);
}

/** axe in both schemes, then the layout gate at 320 CSS px in every supported text size. */
async function gate(page: Page, label: string) {
  await expectNoAxeViolations(page, { label, dark: true });
  const url = page.url();
  await page.setViewportSize(NARROW);
  for (const size of TEXT_SIZES) {
    await page.goto(url);
    await setTextSize(page, size);
    await layoutGate(page, `${label} at 320px, ${size}`, 'main');
    await test.info().attach(`search ${label} 320px ${size}.png`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
}
