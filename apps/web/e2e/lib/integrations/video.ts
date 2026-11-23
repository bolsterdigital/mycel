// Click-to-load video (docs/reference/integrations.md § Video) on a site of its own, so no other
// test meets a player. Off, a page with a YouTube and a Vimeo video has links only, no script and
// no `frame-src`. With YouTube on, the same page frames exactly the nocookie origin, its ETag
// changes, the Vimeo video stays a link, and the browser asks no provider anything until the
// visitor presses the play button by keyboard; then there is one titled, sandboxed player with
// focus. Without JavaScript (`no-js`) the button stays hidden and the link is the video. The pure
// decision is core's `integrations.test.ts`; the header rewrite is `security-headers.test.ts`.
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  BLOCK_DEFINITIONS as DEFS,
  DEFAULT_INTEGRATIONS,
  type EmbedId,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { layoutGate, NARROW, setTextSize } from '../layout';

const PLAYERS =
  /^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com|player\.mediadelivery\.net|[^/]*youtube\.com)\//;

async function seed(slug: string) {
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Video',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
      reuse: true,
    })
  );
  const system = systemPrincipal(tenant.id, 'e2e');
  await withInvoker(async (invoker) => {
    const existing = await invoker.run(useCases.listItems, system, {});
    if (existing.items.some((item) => item.slug === 'video')) return;
    const text = (t: string) => ({
      type: 'rich-text' as const,
      version: DEFS['rich-text'].version,
      props: {
        content: {
          nl: {
            type: 'doc' as const,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          },
          en: {
            type: 'doc' as const,
            content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
          },
        },
      },
    });
    const video = (
      provider: EmbedId,
      videoId: string,
      title: string,
      extras: Partial<(typeof DEFS)['video-embed']['examples'][number]['props']> = {}
    ) => ({
      type: 'video-embed' as const,
      version: DEFS['video-embed'].version,
      props: { provider, videoId, title: { nl: title, en: title }, ...extras },
    });
    const { item, revision } = await invoker.run(useCases.createItem, system, {
      slug: 'video',
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'De opening', en: 'The opening' },
        blocks: [
          text('Eerst wat tekst.'),
          video('youtube', 'dQw4w9WgXcQ', 'De opening'),
          text('Dan nog wat.'),
          video('vimeo', '76979871', 'Het gesprek'),
          video('bunny-stream', '12345/12345678-abcd-4321-9876-0123456789ab', 'De rivierotter', {
            caption: { nl: 'De rivierotter op jacht.', en: 'The river otter hunting.' },
            maker: 'Tom Koerner / U.S. Fish and Wildlife Service',
            makerUrl: 'https://example.org/maker',
            licenceLabel: 'CC BY 2.0',
            licenceUrl: 'https://creativecommons.org/licenses/by/2.0/',
            youtubeWatchId: 'aqz-KE-bpKQ',
          }),
        ],
      },
    });
    await invoker.run(useCases.publishItem, system, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'nl',
    });
    await invoker.run(useCases.publishItem, system, {
      itemId: item.id,
      revisionId: revision.id,
      locale: 'en',
    });
  });
  const set = async (youtube: boolean, bunny = false) => {
    const { version } = await withInvoker((invoker) =>
      invoker.run(useCases.getIntegrationSettings, system, {})
    );
    await withInvoker((invoker) =>
      invoker.run(useCases.updateIntegrationSettings, system, {
        baseVersion: version,
        settings: {
          ...DEFAULT_INTEGRATIONS,
          youtube: { enabled: youtube },
          'bunny-stream': { enabled: bunny },
        },
      })
    );
  };
  return { set };
}

export async function exerciseVideoEmbeds(page: Page) {
  const js = test.info().project.use.javaScriptEnabled !== false;
  const slug = `site-video-${test.info().project.name}`;
  const { set } = await seed(slug);
  const path = `/${slug}/video`;
  const asked: Request[] = [];
  await page.route(PLAYERS, (route) => {
    asked.push(route.request());
    return route.fulfill({ contentType: 'text/html', body: '<title>player</title>' });
  });
  await set(false);
  try {
    // Off: links only, no script, frames fall back to default-src.
    const off = await page.request.get(path);
    const offBody = await off.text();
    expect(offBody).not.toContain('data-embed-src');
    expect(offBody).not.toContain('/_site/embed.js');
    expect(off.headers()['content-security-policy']).not.toContain('frame-src');

    await set(false, true);
    const bunny = await page.request.get(path);
    const bunnyBody = await bunny.text();
    expect(bunny.headers()['content-security-policy']).toContain(
      "frame-src 'self' https://player.mediadelivery.net"
    );
    expect(bunny.headers()['content-security-policy']).not.toContain('youtube-nocookie');
    expect(bunnyBody.match(/data-embed-src=/g)).toHaveLength(1);
    expect(bunnyBody).toContain(
      'https://player.mediadelivery.net/embed/12345/12345678-abcd-4321-9876-0123456789ab?autoplay=true'
    );
    await page.goto(path);
    const bunnyPlay = page.getByRole('button', { name: /De rivierotter/ });
    expect(asked).toHaveLength(0);
    if (js) {
      await bunnyPlay.focus();
      await page.keyboard.press('Enter');
      await expect(page.locator('iframe[title="De rivierotter"]')).toBeFocused();
      await expect
        .poll(() => asked.map((r) => new URL(r.url()).host))
        .toEqual(['player.mediadelivery.net']);
      asked.length = 0;
    } else {
      await expect(bunnyPlay).toBeHidden();
      await expect(page.getByRole('link', { name: 'De rivierotter' })).toBeVisible();
    }

    await page.setViewportSize(NARROW);
    for (const [route, label, caption] of [
      [path, 'Op YouTube', 'De rivierotter op jacht.'],
      [`/${slug}/en/video`, 'On YouTube', 'The river otter hunting.'],
    ] as const) {
      await page.goto(route);
      await setTextSize(page, '200%');
      const watch = page.getByRole('link', { name: label, exact: true });
      await expect(watch).toHaveAttribute('href', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
      await expect(page.locator('.video figcaption').getByText(caption)).toBeVisible();
      const row = (await page.locator('.video-details').boundingBox())!;
      const credit = (await page.locator('.video-credit').boundingBox())!;
      const action = (await watch.boundingBox())!;
      expect(action.y).toBeGreaterThanOrEqual(credit.y + credit.height - 1);
      expect(action.x + action.width).toBeCloseTo(row.x + row.width, 0);
      expect(action.width).toBeGreaterThanOrEqual(44);
      expect(action.height).toBeGreaterThanOrEqual(44);
      expect(await watch.evaluate((link) => link.scrollWidth <= link.clientWidth)).toBe(true);
      await layoutGate(page, label, '.video-details');
    }
    expect(asked).toHaveLength(0);

    await set(true);
    const on = await page.request.get(path);
    const body = await on.text();
    expect(body.match(/<script[^>]*src="\/_site\/embed\.js"/g)).toHaveLength(1);
    expect(body.match(/data-embed-src=/g)).toHaveLength(1);
    expect(body).toContain('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1');
    const csp = on.headers()['content-security-policy']!;
    expect(csp).toContain("frame-src 'self' https://www.youtube-nocookie.com");
    expect(csp).not.toContain('vimeo');
    expect(on.headers()['etag']).not.toBe(off.headers()['etag']);

    await page.goto(path);
    const play = page.getByRole('button', { name: 'Video afspelen: De opening (laadt YouTube)' });
    await expect(page.getByRole('link', { name: 'Het gesprek' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Het gesprek/ })).toHaveCount(0);
    if (!js) {
      await expect(play).toBeHidden();
      await expect(page.getByRole('link', { name: 'De opening' })).toBeVisible();
      expect(asked).toHaveLength(0);
      return;
    }
    await expect(play).toBeVisible();
    await expectNoAxeViolations(page, { label: 'video before the click' });
    await page.setViewportSize(NARROW);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    ).toBeLessThanOrEqual(0);
    expect(asked, 'nothing reaches a provider before the click').toHaveLength(0);

    await play.focus();
    await page.keyboard.press('Enter');
    const player = page.locator('.video-player iframe');
    await expect(player).toHaveCount(1);
    await expect(player).toHaveAttribute('title', 'De opening');
    await expect(player).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(player).toBeFocused();
    await expect
      .poll(() => asked.map((r) => new URL(r.url()).host))
      .toEqual(['www.youtube-nocookie.com']);
  } finally {
    await page.unroute(PLAYERS);
    await set(false);
  }
}
