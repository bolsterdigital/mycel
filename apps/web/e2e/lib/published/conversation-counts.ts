// Published HTML reads the real database cache. The browser fixture injects only count snapshots;
// the worker and outbound adapters are covered separately and need no live provider.
import { type Page, expect, test } from '@playwright/test';
import { systemPrincipal, useCases } from '@mycel/core';
import { conversationCache, withTenant } from '@mycel/db';
import { closeTenantWork, testTenant } from '@mycel/db/testing';
import { asOwner, withInvoker } from '../invoker';
import { expectNoAxeViolations } from '../axe';
import { NARROW, layoutGate, setTextSize } from '../layout';
import { isA11y } from '../project';

const origin = 'https://social.example.org';
const profile = `${origin}/@otterdam`;
const href = `${profile}/123456789`;
const key = { network: 'mastodon', key: href } as const;

export async function exerciseConversationCounts(page: Page) {
  const tenant = await asOwner((owner) =>
    testTenant(owner, `conversation-${crypto.randomUUID()}`, {
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
    })
  );
  const principal = systemPrincipal(tenant.id, 'e2e:conversation-counts');
  const checkedAt = new Date();
  const snapshot = async (replies: number, expiresAt: Date) => {
    await asOwner((db) =>
      withTenant(db, principal, async (trx) => {
        const cache = conversationCache(trx, tenant.id);
        await cache.claim(key, checkedAt, checkedAt);
        await cache.finish(key, checkedAt, { replies, reposts: 0 }, expiresAt);
      })
    );
  };
  const distant = new Date(checkedAt.getTime() + 300_000);
  const path = (locale: string) =>
    `/${tenant.slug}/${locale === 'nl' ? '' : 'en/'}articles/conversation`;
  try {
    await withInvoker(async (invoker) => {
      const { version, value } = await invoker.run(useCases.getSiteChrome, principal, {});
      await invoker.run(useCases.updateSiteChrome, principal, {
        baseVersion: version,
        chrome: { ...value, social: { mastodon: profile } },
      });
      const created = await invoker.run(useCases.createItem, principal, {
        slug: 'conversation',
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Het artikel', en: 'The article' },
          blocks: [
            {
              type: 'social-conversation',
              version: 1,
              props: { mastodonPost: { nl: href, en: href } },
            },
          ],
        },
      });
      for (const locale of ['nl', 'en']) {
        await invoker.run(useCases.publishItem, principal, {
          itemId: created.item.id,
          revisionId: created.revision.id,
          locale,
        });
      }
    });
    await snapshot(1, distant);
    await page.setViewportSize(NARROW);
    const section = page.locator('.social-conversation');
    const foreign: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).origin === origin) foreign.push(request.url());
    });
    for (const [locale, copy] of [
      ['nl', '1 reactie'],
      ['en', '1 reply'],
    ] as const) {
      await page.goto(path(locale));
      await expect(section.getByRole('link', { name: 'Mastodon' })).toHaveAttribute('href', href);
      await expect(section.getByText(copy, { exact: true })).toBeVisible();
      await expect(section.getByText('0 reposts', { exact: true })).toBeVisible();
      await section.getByRole('link', { name: 'Mastodon' }).focus();
      await expect(section.getByRole('link', { name: 'Mastodon' })).toBeFocused();
      if (isA11y()) {
        await setTextSize(page, '200%');
        await layoutGate(page, `conversation counts ${locale} at 320/200%`, '.social-conversation');
        await expectNoAxeViolations(page);
        await section.screenshot({
          path: test.info().outputPath(`conversation-counts-${locale}.png`),
        });
      }
    }
    expect(foreign).toEqual([]);
    const current = await page.request.get(path('nl'));
    const tag = current.headers()['etag']!;
    expect(tag).toBeTruthy();
    expect(current.headers()['cache-control']).toBe(
      'public, max-age=0, stale-while-revalidate=0, must-revalidate'
    );
    const conditional = (etag: string) =>
      page.request.get(path('nl'), { headers: { 'if-none-match': etag } });
    expect((await conditional(tag)).status()).toBe(304);

    await snapshot(12, distant);
    const changed = await conditional(tag);
    expect(changed.status()).toBe(200);
    expect(await changed.text()).toContain('12 reacties');
    const changedTag = changed.headers()['etag']!;
    expect(changedTag).not.toBe(tag);

    await snapshot(12, checkedAt);
    const expired = await conditional(changedTag);
    expect(expired.status()).toBe(200);
    expect(await expired.text()).not.toContain('12 reacties');
    await page.goto(path('nl'));
    await expect(section.getByRole('link', { name: 'Mastodon' })).toHaveAttribute('href', href);
    await expect(section.getByText('0 reposts', { exact: true })).toHaveCount(0);
  } finally {
    await asOwner((owner) => closeTenantWork(owner, [tenant.id]));
  }
}
