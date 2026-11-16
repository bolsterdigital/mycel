// Old addresses (migration 0062): an item renamed after its publication keeps its old slug, which
// forwards to the current path in the same locale with the query intact, and stays until an
// editor removes it on the edit screen. The public part runs on a tenant of its own with two
// locales; the edit screen on `probe`, where `login` works. Core and database suites cover the
// slug being held, chains, a move back, tenant isolation and export.
// Rejected: a spec of its own (the e2e budget), and a stored path per old address, which the
// rename after the rename below would have had to rewrite.
import { expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { systemPrincipal, useCases, type Invoker, type Principal } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { asOwner, tenantId, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { login } from '../login';
import { isA11y } from '../project';

const hex = () => randomBytes(4).toString('hex');

/** A published item, renamed once it is live; its id. */
async function renamed(
  invoker: Invoker,
  principal: Principal,
  type: 'page' | 'article',
  from: string,
  to: string,
  locales: string[]
): Promise<string> {
  const { item, revision } = await invoker.run(useCases.createItem, principal, {
    slug: from,
    document: {
      type,
      defaultLocale: 'nl',
      locales,
      title: { nl: 'Over ons', ...(locales.includes('en') ? { en: 'About us' } : {}) },
      blocks: [],
    } as never,
  });
  for (const locale of locales)
    await invoker.run(useCases.publishItem, principal, {
      itemId: item.id,
      revisionId: revision.id,
      locale,
    });
  await invoker.run(useCases.updateSlug, principal, { itemId: item.id, slug: to });
  return item.id;
}

async function exercisePublic(page: Page) {
  const slug = `old-${hex()}`;
  const { id } = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Old addresses',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const principal = systemPrincipal(id, 'e2e');
  await withInvoker(async (invoker) => {
    await renamed(invoker, principal, 'page', 'over-ons', 'wie-we-zijn', ['nl', 'en']);
    await renamed(invoker, principal, 'article', 'bericht', 'nieuws', ['nl']);
  });
  const hop = async (path: string) => {
    const r = await page.request.get(`/${slug}${path}`, { maxRedirects: 0 });
    return [r.status(), r.headers()['location'] ?? null];
  };
  expect(await hop('/over-ons?utm_source=mail')).toEqual([
    301,
    `/${slug}/wie-we-zijn?utm_source=mail`,
  ]);
  expect(await hop('/en/over-ons')).toEqual([301, `/${slug}/en/wie-we-zijn`]);
  expect(await hop('/articles/bericht')).toEqual([301, `/${slug}/articles/nieuws`]);
  // English of the article is not published: no forward, the 404 the new address gives too.
  expect(await hop('/en/articles/bericht')).toEqual([404, null]);
  // A page's old slug is not an article's.
  expect(await hop('/articles/over-ons')).toEqual([404, null]);
  await page.goto(`/${slug}/en/over-ons`);
  await expect(page).toHaveURL(new RegExp(`/${slug}/en/wie-we-zijn$`));
  await expect(page.locator('h1')).toHaveText('About us');
}

/** The list on the edit screen at 320 px and 200% text, and removing one old address. */
async function exerciseEditScreen(page: Page) {
  const [from, to] = [`oud-${hex()}`, `nieuw-${hex()}`];
  const itemId = await withInvoker((invoker) =>
    tenantId().then((id) => renamed(invoker, systemPrincipal(id, 'e2e'), 'page', from, to, ['nl']))
  );
  await login(page, `/admin/probe/content/${itemId}`);
  const old = page.getByRole('region', { name: 'Old addresses' });
  await expect(old).toContainText(`/${from}`);
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'old addresses' });
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'old addresses at 320 px and 200% text', '.old-addresses');
    await setTextSize(page, '');
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  expect((await page.request.get(`/probe/${from}`, { maxRedirects: 0 })).status()).toBe(301);
  await old.getByRole('button', { name: `Remove /${from}` }).click();
  await expect(page.getByRole('status')).toContainText('The old address was removed');
  await expect(old).toHaveCount(0);
  expect((await page.request.get(`/probe/${from}`, { maxRedirects: 0 })).status()).toBe(404);
}

export async function exerciseOldAddresses(page: Page) {
  await exercisePublic(page);
  await exerciseEditScreen(page);
}
