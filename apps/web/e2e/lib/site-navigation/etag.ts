// ADR 036 rule 11 on a public page: a menu link without its own label reads the target's
// published metadata, so a publication or withdrawal changes the header and validator without
// a navigation edit. Drafts and other locales stay out of that change. A tenant of its own keeps
// parallel site-settings tests independent. Rejected: a simulated cache or elapsed-time sleep;
// conditional origin requests prove revalidation, and response headers state the cache window.
// This is not a deployed shared-cache or purge test.
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { expect, type APIRequestContext, type TestInfo } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { asOwner, withInvoker } from '../invoker';
import { publishMenus } from './seed';

async function seed() {
  const navSlug = `nav-etag-${randomBytes(4).toString('hex')}`;
  const { id } = await asOwner((owner) =>
    testTenant(owner, navSlug, {
      name: 'Navigation ETag',
      locales: ['nl', 'en'],
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
          locales: ['nl', 'en'],
          title: { nl: title, en: `English ${title}` },
          blocks: [],
        },
      });
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, principal, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
      return item.id;
    };
    await page('home', 'Start');
    const itemId = await page('over', 'Over ons');
    // The second node has its own text and must not follow the target's title.
    await publishMenus(
      invoker,
      principal,
      { main: [{ itemId }, { itemId, label: { nl: 'Vast', en: 'Fixed' } }] },
      ['nl', 'en']
    );
    return itemId;
  });
  const navigation = await withInvoker((invoker) =>
    invoker.run(useCases.getNavigation, principal, {})
  );
  return { navSlug, principal, target, navigation };
}

export async function exerciseNavigationEtag(request: APIRequestContext, info: TestInfo) {
  const { navSlug, principal, target, navigation } = await seed();
  const path = (locale: string) => `/${navSlug}/${locale === 'nl' ? '' : 'en/'}home`;
  const observations: unknown[] = [];
  const read = async (locale: string, etag?: string) => {
    const res = await request.get(path(locale), {
      headers: etag ? { 'if-none-match': etag } : {},
    });
    const body = await res.text();
    const tag = res.headers()['etag'];
    expect(tag, 'a strong validator, never an undefined comparison').toMatch(/^"[^"\\]+"$/);
    const cache = res.headers()['cache-control'];
    expect(cache).toBe('public, max-age=60, stale-while-revalidate=600');
    const nav = body.match(
      /<nav[^>]*aria-label="(?:Hoofdnavigatie|Main navigation)"[^>]*>([\s\S]*?)<\/nav>/
    )?.[1];
    const links = [...(nav ?? '').matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((match) =>
      match.slice(1, 3)
    );
    const state = { locale, status: res.status(), etag: tag!, cache, links };
    observations.push(state);
    if (res.status() === 304) expect(body).toBe('');
    else expect(res.status()).toBe(200);
    return state;
  };
  const current = async (locale: string, etag: string) => {
    const cached = await read(locale, etag);
    expect(cached.status).toBe(304);
    expect(cached.etag).toBe(etag);
  };
  try {
    const before = { nl: await read('nl'), en: await read('en') };
    for (const locale of ['nl', 'en'] as const) {
      expect(before[locale].links).toEqual([
        [
          `/${navSlug}/${locale === 'nl' ? '' : 'en/'}over`,
          locale === 'nl' ? 'Over ons' : 'English Over ons',
        ],
        [`/${navSlug}/${locale === 'nl' ? '' : 'en/'}over`, locale === 'nl' ? 'Vast' : 'Fixed'],
      ]);
      await current(locale, before[locale].etag);
    }
    const saved = await withInvoker(async (invoker) => {
      const { item, revision } = await invoker.run(useCases.getItem, principal, { itemId: target });
      return invoker.run(useCases.updateItem, principal, {
        itemId: target,
        baseRevisionId: item.latestRevisionId,
        document: {
          ...revision.document,
          title: { nl: 'Wie wij zijn', en: 'Who we are' },
          featured: { title: { nl: 'Kort', en: 'Brief' } },
        },
      });
    });
    // A new draft title/featured title must not invalidate either public representation.
    for (const locale of ['nl', 'en'] as const) await current(locale, before[locale].etag);
    for (const locale of ['nl', 'en'] as const) {
      await withInvoker((invoker) =>
        invoker.run(useCases.publishItem, principal, {
          itemId: target,
          revisionId: saved.revision.id,
          locale,
        })
      );
      const after = await read(locale, before[locale].etag);
      expect(after.status, 'an old validator cannot preserve an old menu').toBe(200);
      expect(after.etag).not.toBe(before[locale].etag);
      expect(after.links).toEqual([
        [before[locale].links[0]![0], locale === 'nl' ? 'Kort' : 'Brief'],
        before[locale].links[1],
      ]);
      await current(locale, after.etag);
      if (locale === 'nl') await current('en', before.en.etag);
      await withInvoker((invoker) =>
        invoker.run(useCases.unpublishItem, principal, { itemId: target, locale })
      );
      const offline = await read(locale, after.etag);
      expect(offline.status, 'withdrawal invalidates the page containing the menu').toBe(200);
      expect(offline.etag).not.toBe(after.etag);
      expect(offline.links).toEqual([]);
      await current(locale, offline.etag);
      if (locale === 'nl') await current('en', before.en.etag);
      const targetResponse = await request.get(before[locale].links[0]![0]!);
      expect(targetResponse.status()).toBe(404);
      expect(targetResponse.headers()['cache-control']).toBe('no-store');
    }
    const unchanged = await withInvoker((invoker) =>
      invoker.run(useCases.getNavigation, principal, {})
    );
    expect(unchanged).toEqual(navigation);
  } finally {
    const path = info.outputPath('navigation-origin-validators.json');
    await writeFile(
      path,
      JSON.stringify({ project: info.project.name, navSlug, observations }, null, 2)
    );
    await info.attach('navigation-origin-validators', {
      path,
      contentType: 'application/json',
    });
  }
}
