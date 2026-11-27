// "Read more" under an article (MY-304) on a tenant of its own, so parallel suites cannot add
// articles to the row: the section's newest first, filled up with the site's newest, in nl and en,
// with and without JavaScript (the project), axe-clean and without sideways scrolling at 320 px
// and 200% text. A newly published article in the section is a new card and a new validator.
// Which articles qualify one by one is the core suite (read-more.test.ts in memory and Postgres).
// Rejected: the shared probe tenant, where every suite that publishes an article moves the row.
import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { systemPrincipal, useCases, type Principal } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';
import { shareCardOf } from './share-cards';

async function article(principal: Principal, slug: string, sectionId?: string) {
  await withInvoker(async (invoker) => {
    const { item, revision } = await invoker.run(useCases.createItem, principal, {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: `Stuk ${slug}`, en: `Story ${slug}` },
        lead: { nl: `Over ${slug}.`, en: `About ${slug}.` },
        blocks: [],
        ...(sectionId ? { sectionId } : {}),
      } as never,
    });
    for (const locale of ['nl', 'en'])
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale,
      });
  });
}

async function seed() {
  const slug = `lees-verder-${randomBytes(4).toString('hex')}`;
  const { id } = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Lees verder',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const principal = systemPrincipal(id, 'e2e');
  const section = await withInvoker((invoker) =>
    invoker.run(useCases.createSection, principal, {
      slug: 'stad',
      title: { nl: 'Stad', en: 'City' },
    })
  );
  // Published one after the other, so `newest` has an order: two in the section, two outside.
  await article(principal, 'stad-oud', section.id);
  await article(principal, 'los-oud');
  await article(principal, 'los-nieuw');
  await article(principal, 'stad-nieuw', section.id);
  await article(principal, 'hier', section.id);
  return { slug, principal, sectionId: section.id };
}

const cards = (page: Page, name: string) =>
  page.getByRole('region', { name }).getByRole('heading', { level: 3 });

export async function exerciseReadMore(page: Page, request: APIRequestContext) {
  const { slug, principal, sectionId } = await seed();
  const path = (locale: 'nl' | 'en') => `/${slug}/${locale === 'nl' ? '' : 'en/'}articles/hier`;

  await page.goto(path('nl'));
  await expect(cards(page, 'Lees verder')).toHaveText([
    'Stuk stad-nieuw',
    'Stuk stad-oud',
    'Stuk los-nieuw',
  ]);
  await expect(
    page.getByRole('region', { name: 'Lees verder' }).getByRole('link', { name: 'Stuk stad-oud' })
  ).toHaveAttribute('href', `/${slug}/articles/stad-oud`);
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'read more under an article' });
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'read more at 320 px and 200% text', '.read-more');
    await setTextSize(page, '');
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.goto(path('en'));
  await expect(cards(page, 'Read more')).toHaveText([
    'Story stad-nieuw',
    'Story stad-oud',
    'Story los-nieuw',
  ]);

  // A new article in the section: first card, and the old validator no longer holds. The page's
  // own share card is drawn first, since the head is in the tag too (navigation etag.ts).
  await shareCardOf(request, path('nl'));
  const before = await request.get(path('nl'));
  const etag = before.headers()['etag']!;
  expect(etag).toMatch(/^"[^"\\]+"$/);
  expect((await request.get(path('nl'), { headers: { 'if-none-match': etag } })).status()).toBe(
    304
  );
  await article(principal, 'stad-nieuwst', sectionId);
  const after = await request.get(path('nl'), { headers: { 'if-none-match': etag } });
  expect(after.status()).toBe(200);
  expect(after.headers()['etag']).not.toBe(etag);
  // The browser holds the page for its cache lifetime; a reload revalidates with the old tag.
  await page.goto(path('nl'));
  await page.reload();
  await expect(cards(page, 'Lees verder')).toHaveText([
    'Stuk stad-nieuwst',
    'Stuk stad-nieuw',
    'Stuk stad-oud',
  ]);
}
