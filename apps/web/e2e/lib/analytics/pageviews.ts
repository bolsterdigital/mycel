// The public script gate (docs/reference/analytics.md § Pageviews) on a site of its
// own, so no other test meets a tag. Off, a published page has no tag; on, a successful GET of a
// published public item has exactly one, and the request the browser sends is read from the
// network, not from the HTML: the address is the decision's path on the primary hostname, even
// when the page was opened by its development path form with a token in a query value and a
// fragment. A restricted item, a confirm page, a missing page and a failed form post get no tag.
// The ETag follows the setting. In `a11y` the browser runs the script and the CSP refuses any
// other origin; in `no-js` the same pages are whole without it. The pure decision is core's
// `analytics.test.ts`; the script's refusal to read the page is `analytics.test.ts` in the web.
import { expect, test, type Page, type Request } from '@playwright/test';
import { PLAUSIBLE_EVENT_ENDPOINT, PLAUSIBLE_ORIGIN, systemPrincipal, useCases } from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { asOwner, withInvoker } from '../invoker';

const TAG = /<script[^>]*src="\/_site\/pageview\.js"[^>]*>/g;

async function seed(slug: string) {
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Pageviews',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
      reuse: true,
    })
  );
  const system = systemPrincipal(tenant.id, 'e2e');
  await withInvoker(async (invoker) => {
    const existing = await invoker.run(useCases.listItems, system, {});
    const have = new Set(existing.items.map((item) => item.slug));
    const item = async (
      slug: string,
      type: 'page' | 'article',
      access: { level: 'public' } | { level: 'members'; teaser: 'lead' } = { level: 'public' }
    ) => {
      if (have.has(slug)) return;
      const { item, revision } = await invoker.run(useCases.createItem, system, {
        slug,
        document: {
          type,
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: `Titel ${slug}`, en: `Title ${slug}` },
          lead: { nl: 'Een lead.', en: 'A lead.' },
          access,
          blocks: [],
        },
      });
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, system, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
    };
    await item('over-ons', 'page');
    await item('lid-12345678', 'page');
    await item('besloten', 'article', { level: 'members', teaser: 'lead' });
  });
  const set = async (plausibleDomain: string | null) => {
    const { version } = await withInvoker((invoker) =>
      invoker.run(useCases.getAnalyticsSettings, system, {})
    );
    await withInvoker((invoker) =>
      invoker.run(useCases.updateAnalyticsSettings, system, {
        baseVersion: version,
        settings: { plausibleDomain },
      })
    );
  };
  return { set };
}

/** The pageview the browser posts on `path`, read from the network; Plausible is not contacted. */
async function sentPageview(page: Page, path: string) {
  const sent: Request[] = [];
  await page.route(PLAUSIBLE_EVENT_ENDPOINT, (route) => {
    sent.push(route.request());
    return route.fulfill({ status: 202, body: 'ok' });
  });
  await page.goto(path);
  await expect.poll(() => sent.length).toBe(1);
  await page.unroute(PLAUSIBLE_EVENT_ENDPOINT);
  const [request] = sent as [Request];
  return { body: JSON.parse(request.postData() ?? 'null'), headers: await request.allHeaders() };
}

export async function exercisePageviews(page: Page, baseURL: string) {
  const js = test.info().project.use.javaScriptEnabled !== false;
  const slug = `site-pageviews-${test.info().project.name}`;
  const { set } = await seed(slug);
  const primary = `http://${slug}.${process.env['PLATFORM_DOMAIN']!}:${new URL(baseURL).port}`;
  const html = async (path: string) => {
    const res = await page.request.get(path);
    return { res, body: await res.text() };
  };
  await set(null);
  try {
    // Off: no tag, and the ETag says so.
    const off = await html(`/${slug}/over-ons`);
    expect(off.res.status()).toBe(200);
    expect(off.body.match(TAG)).toBeNull();
    const offTag = off.res.headers()['etag'];

    await set('example.org');
    const on = await html(`/${slug}/over-ons?ref=token-0123456789abcdef`);
    expect(on.body.match(TAG)).toHaveLength(1);
    expect(on.body).toContain(`data-url="${primary}/over-ons"`);
    expect(on.body).not.toContain('token-0123456789abcdef');
    expect(on.res.headers()['etag']).not.toBe(offTag);
    expect(on.res.headers()['content-security-policy']).toContain(
      `connect-src 'self' ${PLAUSIBLE_ORIGIN}`
    );

    // Never a tag: a restricted item for an anonymous visitor, a confirm page with its token,
    // a page that does not exist, a failed form post, and a token-named query key.
    expect((await html(`/${slug}/articles/besloten`)).body.match(TAG)).toBeNull();
    const confirm = await html(`/${slug}/confirm?token=abc`);
    expect(confirm.body.match(TAG)).toBeNull();
    expect(confirm.res.headers()['cache-control']).toContain('no-store');
    expect(confirm.res.headers()['referrer-policy']).toBe('strict-origin');
    const missing = await html(`/${slug}/bestaat-niet`);
    expect(missing.res.status()).toBe(404);
    expect(missing.body.match(TAG)).toBeNull();
    expect((await html(`/${slug}/over-ons?Token=x`)).body.match(TAG)).toBeNull();
    const post = await page.request.post(`/${slug}/over-ons`, {
      headers: {
        origin: baseURL,
        'content-type': 'application/x-www-form-urlencoded',
        'x-forwarded-proto': 'http',
      },
      data: 'formId=',
      maxRedirects: 0,
    });
    expect(post.status()).toBeGreaterThanOrEqual(400);
    expect((await post.text()).match(TAG)).toBeNull();

    // A slug shaped like a number is counted under its type, in either locale.
    expect((await html(`/${slug}/lid-12345678`)).body).toContain(`data-url="${primary}/-"`);
    expect((await html(`/${slug}/en/over-ons`)).body).toContain(
      `data-url="${primary}/en/over-ons"`
    );

    if (!js) {
      // Without JavaScript the counted page is whole and sends nothing.
      await page.goto(`/${slug}/over-ons`);
      await expect(page.getByRole('heading', { level: 1, name: 'Titel over-ons' })).toBeVisible();
      return;
    }

    // What the browser actually sends: the decision, never the address it was opened on.
    const { body, headers } = await sentPageview(
      page,
      `/${slug}/en/over-ons?ref=token-0123456789abcdef#section`
    );
    expect(body).toEqual({ n: 'pageview', u: `${primary}/en/over-ons`, d: 'example.org', r: null });
    expect(headers['referer']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();

    // The policy lets the page reach Plausible's origin and refuses every other one.
    const refused = await page.evaluate(() =>
      fetch('https://elsewhere.example/collect', { method: 'POST', mode: 'no-cors' }).then(
        () => 'sent',
        () => 'refused'
      )
    );
    expect(refused).toBe('refused');
  } finally {
    await set(null);
  }
}
