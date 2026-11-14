// The site search page (`/search?q=`) as a visitor uses it: the GET form works without JavaScript,
// the results are what a visitor may read (a title hit first, matches marked, a restricted,
// `noindex` or never published item absent, a later draft not searched), the other locale has its
// own page, and the page is `noindex` and cached like content. Core and the adapter-rules
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
  await withInvoker(async (invoker) => {
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
    const body = `Een langere tekst over de buurt waarin ${word} pas halverwege voorkomt.`;
    const later = await make(
      invoker,
      principal,
      slug('tekst'),
      {
        type: 'article',
        title: { nl: 'Bomen en banken', en: 'Trees' },
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
      slug('leden'),
      {
        type: 'article',
        ...hidden,
        access: { level: 'members' },
      },
      ['nl']
    );
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
  await expect(page.locator('search form[method="get"] input[type="search"]')).toHaveAttribute(
    'maxlength',
    '200'
  );
  await page.getByLabel('Zoek op deze site').fill(`  ${word}  `);
  await page.getByRole('button', { name: 'Zoeken' }).click();
  await expect(page).toHaveURL(new RegExp(`/probe/search\\?q=\\+*${word}`));

  // (b) Results: the title hit first, the body hit with its match marked; nothing else.
  const res = await page.goto(`/probe/search?q=${word}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toBe('public, max-age=60, stale-while-revalidate=600');
  expect(res?.headers()['x-robots-tag']).toBe('noindex');
  expect(res?.headers()['etag']).toMatch(/^"/);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
  await expect(page.locator('main h1')).toHaveText(`Resultaten voor ‘${word}’`);
  const results = page.locator('.search-results > li');
  await expect(results).toHaveCount(2);
  await expect(results.nth(0).locator('h2 a')).toHaveText(`Over ${word}`);
  await expect(results.nth(0).locator('h2 a')).toHaveAttribute('href', `/probe/${slug('titel')}`);
  await expect(results.nth(1).locator('h2 a')).toHaveText('Bomen en banken');
  await expect(results.nth(1).locator('h2 a')).toHaveAttribute(
    'href',
    `/probe/articles/${slug('tekst')}`
  );
  await expect(results.nth(1).locator('mark')).toHaveText(word);
  await expect(results.nth(1).locator('time')).toHaveAttribute('datetime', /^\d{4}-/);
  await expect(page.locator('main')).not.toContainText('Niet vinden');
  await expect(page.locator('main')).not.toContainText('Concepttitel');
  expect((await page.goto(`/probe/search?q=${word}draft`))?.status()).toBe(200);
  await expect(results).toHaveCount(0);
  await expect(page.locator('.search-empty')).toHaveText(
    'Niets gevonden. Probeer andere of minder woorden.'
  );
  if (isA11y()) await gate(page, 'no results');

  // (c) The English page searches the English text, in English.
  await page.goto(`/probe/en/search?q=${word}`);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('main h1')).toHaveText(`Results for “${word}”`);
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

  if (isA11y()) {
    await page.goto(`/probe/search?q=${word}`);
    await gate(page, 'results');
  }
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
