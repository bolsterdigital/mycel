// The consent choice and the tag manager behind it (docs/reference/integrations.md § Consent), on
// a site of its own with Google Tag Manager on for `marketing` and Google Analytics as its one
// vendor. Google is never contacted: Playwright answers every Google and Meta host with a stub,
// and the stub `gtm.js` does what a container does, inject a vendor script and send beacons, one
// set for the chosen vendor and one for Meta, which the site did not choose.
//
// Before a choice the banner shows and nothing reaches those hosts; refusing keeps it so, also
// after a reload; accepting loads `gtm.js` for the container, the chosen vendor's script and
// beacon, and never Meta's (the Trusted Types policy and the CSP refuse it); withdrawing on the
// choice page, reached from the footer, stops it. A page with a form, another tenant and the
// `no-js` project get no banner and load nothing; without JavaScript the choice page still sets
// the cookie. The banner and the choice page pass the layout gate at 320 px and 200 % text in
// both languages. The decision is core's `integrations.test.ts`, the header rewrite
// `security-headers.test.ts`, the script in a sandbox `consent.test.ts`.
import { expect, test, type Page, type Request } from '@playwright/test';
import {
  BLOCK_DEFINITIONS as DEFS,
  DEFAULT_INTEGRATIONS,
  systemPrincipal,
  useCases,
} from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { expectNoAxeViolations } from '../axe';
import { asOwner, withInvoker } from '../invoker';
import { NARROW, layoutGate, setTextSize } from '../layout';

const THIRD = /^https:\/\/[^/]*(googletagmanager\.com|google-analytics\.com|facebook\.(com|net))\//;
const CONTAINER = 'GTM-TEST41';

/** What a container does once it runs: a vendor script and a beacon, chosen and not chosen. */
const STUB_GTM = `(() => {
  const add = (src) => { try { const s = document.createElement('script'); s.src = src; document.head.append(s); } catch {} };
  add('https://www.googletagmanager.com/gtag/js?id=G-TEST');
  add('https://connect.facebook.net/en_US/fbevents.js');
  new Image().src = 'https://www.google-analytics.com/g/collect?v=2';
  new Image().src = 'https://www.facebook.com/tr?id=1';
})();`;

async function tenantWith(slug: string, gtm: boolean, blocks: (form: string) => unknown[]) {
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Consent',
      locales: ['nl', 'en'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
      reuse: true,
    })
  );
  const system = systemPrincipal(tenant.id, 'e2e');
  await withInvoker(async (invoker) => {
    const existing = await invoker.run(useCases.listItems, system, {});
    if (existing.items.length > 0) return;
    const form = await invoker.run(useCases.createForm, system, { kind: 'donation' });
    const text = (t: string) => ({
      type: 'rich-text' as const,
      version: DEFS['rich-text'].version,
      props: {
        content: Object.fromEntries(
          ['nl', 'en'].map((l) => [
            l,
            { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] },
          ])
        ),
      },
    });
    const pages: [string, unknown[]][] = [
      ['nieuws', [text('Het nieuws van deze week.')]],
      ['steun', [text('Steun ons.'), ...blocks(form.id)]],
    ];
    for (const [itemSlug, content] of pages) {
      const { item, revision } = await invoker.run(useCases.createItem, system, {
        slug: itemSlug,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: `Titel ${itemSlug}`, en: `Title ${itemSlug}` },
          blocks: content as never,
        },
      });
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, system, {
          itemId: item.id,
          revisionId: revision.id,
          locale,
        });
    }
  });
  const { version } = await withInvoker((invoker) =>
    invoker.run(useCases.getIntegrationSettings, system, {})
  );
  await withInvoker((invoker) =>
    invoker.run(useCases.updateIntegrationSettings, system, {
      baseVersion: version,
      settings: {
        ...DEFAULT_INTEGRATIONS,
        'google-tag-manager': {
          enabled: gtm,
          containerId: CONTAINER,
          category: 'marketing',
          vendors: ['google-analytics'],
        },
      },
    })
  );
}

/** The banner and the choice page whole at 320 px and 200 % text; a screenshot as evidence. */
async function gate(page: Page, within: string, shot: string) {
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, `${shot} at 320 px and 200 %`, within);
  const path = test.info().outputPath(`${shot}.png`);
  await page.screenshot({ path, fullPage: true });
  await test.info().attach(shot, { path, contentType: 'image/png' });
  await setTextSize(page, '100%');
  await page.setViewportSize({ width: 1280, height: 900 });
}

export async function exerciseConsent(page: Page) {
  const js = test.info().project.use.javaScriptEnabled !== false;
  const slug = `site-consent-${test.info().project.name}`;
  await tenantWith(slug, true, (form) => [
    { type: 'form', version: DEFS.form.version, props: { formId: form } },
  ]);
  await tenantWith(`${slug}-b`, false, () => []);
  const news = `/${slug}/nieuws`;
  const asked: Request[] = [];
  const hosts = () => asked.map((r) => `${new URL(r.url()).host}${new URL(r.url()).pathname}`);
  await page.route(THIRD, (route) => {
    asked.push(route.request());
    const { pathname } = new URL(route.request().url());
    return pathname === '/gtm.js'
      ? route.fulfill({ contentType: 'text/javascript', body: STUB_GTM })
      : route.fulfill({ contentType: 'text/javascript', body: '' });
  });
  try {
    // The page that places the tag manager: the hidden banner, the loader, the origins, the link.
    const on = await page.request.get(news);
    const body = await on.text();
    expect(on.status()).toBe(200);
    expect(body.match(/<script[^>]*src="\/_site\/consent\.js"/g)).toHaveLength(1);
    expect(body).toContain(`data-container="${CONTAINER}"`);
    expect(body).toMatch(/<section class="consent-banner"[^>]*hidden/);
    expect(body).toContain(`/${slug}/_consent?return=`);
    const csp = on.headers()['content-security-policy']!;
    expect(csp).toMatch(/script-src [^;]*https:\/\/www\.googletagmanager\.com/);
    expect(csp).toMatch(/connect-src [^;]*https:\/\/www\.google-analytics\.com/);
    expect(csp).toMatch(/trusted-types [^;]*\bdefault\b/);
    expect(csp).not.toContain('facebook');
    expect(csp, 'a tenant value never enters the CSP').not.toContain(CONTAINER);
    // A page with a form, and another tenant: nothing of it.
    for (const path of [`/${slug}/steun`, `/${slug}-b/nieuws`]) {
      const other = await page.request.get(path);
      const html = await other.text();
      expect(html, path).not.toMatch(/consent\.js|consent-banner|_consent/);
      expect(other.headers()['content-security-policy'], path).not.toMatch(
        /googletagmanager|trusted-types [^;]*\bdefault\b/
      );
    }

    await page.goto(news);
    const banner = page.getByRole('region', { name: 'Tags op deze site' });
    if (!js) {
      await expect(banner).toBeHidden();
      // The choice page sets the cookie without a script; still nothing loads.
      await page.goto(`/${slug}/_consent?return=${encodeURIComponent(news)}`);
      await page.getByRole('checkbox', { name: 'Marketing' }).check();
      await page.getByRole('button', { name: 'Keuze opslaan' }).click();
      await expect(page).toHaveURL(new RegExp(`${news}$`));
      const cookies = await page.context().cookies();
      expect(cookies.find((c) => c.name === 'mycel_consent')?.value).toBe('1.marketing');
      expect(asked).toEqual([]);
      return;
    }
    await expect(banner).toBeVisible();
    await expectNoAxeViolations(page, { label: 'consent banner' });
    await gate(page, '.consent-banner', 'consent-banner-nl');
    expect(asked, 'nothing reaches Google before a choice').toEqual([]);

    // Refuse: nothing, also after a reload.
    await page.getByRole('button', { name: 'Alleen noodzakelijk' }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(banner).toBeHidden();
    expect(asked, 'nothing after refusing').toEqual([]);

    // Accept, in English this time: the container, the chosen vendor, never Meta.
    await page.context().clearCookies();
    await page.goto(`/${slug}/en/nieuws`);
    const en = page.getByRole('region', { name: 'Tags on this site' });
    await expect(en).toBeVisible();
    await gate(page, '.consent-banner', 'consent-banner-en');
    await page.getByRole('button', { name: 'Accept all' }).click();
    await expect(en).toBeHidden();
    await expect
      .poll(hosts)
      .toEqual(
        expect.arrayContaining([
          'www.googletagmanager.com/gtm.js',
          'www.googletagmanager.com/gtag/js',
          'www.google-analytics.com/g/collect',
        ])
      );
    expect(new URL(asked[0]!.url()).searchParams.get('id')).toBe(CONTAINER);
    expect(
      hosts().filter((h) => /facebook/.test(h)),
      'an unchosen vendor is refused'
    ).toEqual([]);

    // Withdraw from the footer link: after saving, the page loads nothing any more.
    await page.goto(news);
    await page.getByRole('link', { name: 'Cookie-instellingen' }).click();
    await expect(page.getByRole('checkbox', { name: 'Marketing' })).toBeChecked();
    await gate(page, 'main', 'consent-choice-nl');
    await expectNoAxeViolations(page, { label: 'consent choice page' });
    await page.getByRole('checkbox', { name: 'Marketing' }).uncheck();
    await page.getByRole('checkbox', { name: 'Statistiek' }).uncheck();
    asked.length = 0;
    await page.getByRole('button', { name: 'Keuze opslaan' }).click();
    await expect(page).toHaveURL(new RegExp(`${news}$`));
    await page.waitForLoadState('load');
    await expect(banner).toBeHidden();
    expect(asked, 'nothing after withdrawing').toEqual([]);
  } finally {
    await page.unroute(THIRD);
    await tenantWith(slug, false, () => []);
  }
}
