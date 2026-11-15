// ADR 036 rule 11 on a public page: a menu link without its own label reads the target's
// published title, so republishing the target with a new title changes the header and the page's
// ETag, with no navigation revision. A tenant of its own, so the menus of the site-settings tests
// stay as they are. Fresh requests, not a page: a browser would reuse its copy for the freshness
// window (max-age 60), which the rule allows and this test is not about.
import { randomBytes } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { asOwner, withInvoker } from '../invoker';
import { publishMenus } from './seed';

export async function exerciseNavigationEtag(request: APIRequestContext) {
  const navSlug = `nav-etag-${randomBytes(4).toString('hex')}`;
  const { id } = await asOwner((owner) =>
    testTenant(owner, navSlug, {
      name: 'Navigation ETag',
      locales: ['nl'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const principal = systemPrincipal(id, 'e2e');
  const target = await withInvoker(async (invoker) => {
    const page = async (slug: string, title: string) => {
      const { item, revision } = await invoker.run(useCases.createItem, principal, {
        slug,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: title },
          blocks: [],
        } as never,
      });
      await invoker.run(useCases.publishItem, principal, {
        itemId: item.id,
        revisionId: revision.id,
        locale: 'nl',
      });
      return item.id;
    };
    await page('home', 'Start');
    const itemId = await page('over', 'Over ons');
    // No own label: the link reads the target's published title.
    await publishMenus(invoker, principal, { main: [{ itemId }] }, ['nl']);
    return itemId;
  });
  const bar = async () => {
    const res = await request.get(`/${navSlug}/home`);
    const html = await res.text();
    const nav = html.slice(html.indexOf('aria-label="Hoofdnavigatie"'));
    const link = /<a href="([^"]+)"[^>]*>([^<]+)<\/a>/.exec(nav);
    return { etag: res.headers()['etag'], link: link?.slice(1, 3) };
  };
  const before = await bar();
  expect(before.link).toEqual([`/${navSlug}/over`, 'Over ons']);
  await withInvoker(async (invoker) => {
    const { item, revision } = await invoker.run(useCases.getItem, principal, { itemId: target });
    const saved = await invoker.run(useCases.updateItem, principal, {
      itemId: target,
      baseRevisionId: item.latestRevisionId,
      document: { ...revision.document, title: { nl: 'Wie wij zijn' } },
    });
    await invoker.run(useCases.publishItem, principal, {
      itemId: target,
      revisionId: saved.revision.id,
      locale: 'nl',
    });
  });
  // The navigation revision did not change; the home page's header and its ETag did.
  const after = await bar();
  expect(after.link).toEqual([`/${navSlug}/over`, 'Wie wij zijn']);
  expect(after.etag).not.toBe(before.etag);
}
