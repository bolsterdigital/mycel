// flow: publish
// The versioned quality corpus is published by scripts/e2e/e2e.mjs through the same use cases as
// ordinary content. The manifest is an identity contract for #43B, not a second page renderer.
// Rejected: accepting a 200 from an empty shell, redirect or unrelated seeded page as a sample.
import AxeBuilder from '@axe-core/playwright';
import { THEME_PRESETS, Theme, UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import { type Browser, expect, test } from '@playwright/test';
import corpus from './quality-corpus.json' with { type: 'json' };
import checklist from '../../../scripts/quality/spec-checklist.json' with { type: 'json' };
import { type Sample, specFailures } from '../../../scripts/quality/spec-check.mjs';
import { themeCss } from '../src/lib/theme/tokens.js';
import { WCAG, expectNoAxeViolations, nativeSemanticsProblems } from './lib/axe';
import { mobileInputProblems } from './lib/forms';
import { tenantId, withInvoker } from './lib/invoker';
import {
  NARROW,
  focusObscuredProblems,
  forcedColorsProblems,
  layoutGate,
  setTextSize,
  setTextSpacing,
  tabStops,
} from './lib/layout';
import { bfcacheBrowser, bfcacheRestore } from './lib/bfcache';
import { arrivesFetchedAhead } from './lib/speculation';
import { type LocaleMetadata, localeMetadata, localeMetadataProblems } from './lib/metadata';
import { login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, requireApi } from './lib/api';

// Only the default set: scripts/e2e/e2e.mjs seeds the demo page and article under --quality alone,
// and the quality runner checks their identity itself (validateIdentity) in the demo scope. Same
// rule as publicNames(manifest, 'default') in scripts/quality/matrix.mjs.
// Rejected: seeding the demo content in every e2e run, which grows every list a spec counts.
const entries = Object.values(corpus.public).filter(
  (entry) => ((entry as { set?: string }).set ?? 'default') === 'default'
);
const qualityAdmin = 'quality-admin@probe.test';

test.beforeAll(async () => {
  const probe = await tenantId();
  await withInvoker(async (invoker) => {
    try {
      await invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
        email: qualityAdmin,
        capabilities: ['tenant:admin'],
      });
    } catch (error) {
      if (!(error instanceof UseCaseError && error.code === 'conflict')) throw error;
    }
  });
});

test.use({ extraHTTPHeaders: { 'x-forwarded-proto': 'http' } });

for (const entry of entries)
  for (const [locale, identity] of Object.entries(entry.locales))
    test(`${entry.slug} ${locale}: published identity, content and resources`, async ({ page }) => {
      const failed: string[] = [];
      const foreign: string[] = [];
      const origin = new URL(test.info().project.use.baseURL ?? 'http://127.0.0.1:4173').origin;
      page.on('requestfailed', (request) => failed.push(request.url()));
      page.on('request', (request) => {
        if (new URL(request.url()).origin !== origin) foreign.push(request.url());
      });
      const response = await page.goto(identity.path, { waitUntil: 'load' });
      expect(response?.status()).toBe(entry.expected.status);
      expect(new URL(page.url()).pathname).toBe(identity.path);
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(identity.title);
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        new RegExp(
          `${locale === 'en' ? '/en' : ''}/${entry.routeClass === 'article' ? 'articles/' : ''}${entry.slug}$`
        )
      );
      await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
      await expect(page.locator('link[rel="stylesheet"][href*="/_theme/"]')).toHaveCount(1);
      await expect(page.locator('link[rel="preload"][as="font"]')).toHaveCount(1);
      expect(await page.locator('main img').count()).toBeGreaterThanOrEqual(
        entry.expected.minImages
      );
      if (entry.routeClass === 'article' && 'minWords' in entry.expected) {
        const words = (await page.locator('main').innerText()).trim().split(/\s+/u);
        expect(words.length).toBeGreaterThanOrEqual(entry.expected.minWords);
        await expect(page.locator('main h2')).not.toHaveCount(0);
        await expect(page.locator('main ul')).not.toHaveCount(0);
        await expect(page.locator('main ol')).not.toHaveCount(0);
        await expect(page.locator('main blockquote')).not.toHaveCount(0);
        await expect(page.locator('main a[href]')).not.toHaveCount(0);
      } else if ('form' in entry.expected) {
        await expect(page.locator('main form[method="post"]')).toHaveCount(
          entry.expected.form ? 1 : 0
        );
      }
      if ('closingProse' in entry.expected) {
        await expect(page.locator('main .hero')).toHaveCount(0);
        expect(await page.locator('main .rich-text').count()).toBeGreaterThanOrEqual(
          entry.expected.minProseBlocks
        );
        const prose = page.locator('main > .rich-text');
        await expect(prose.last()).toHaveText((await prose.first().textContent())!);
        await expect(page.locator('main > :last-child')).toHaveClass(/rich-text/);
      }
      for (const img of await page.locator('main img').all()) {
        await expect(img).toHaveAttribute('width', /\d+/);
        await expect(img).toHaveAttribute('height', /\d+/);
        if (isA11y()) {
          await img.scrollIntoViewIfNeeded();
          await expect
            .poll(() => img.evaluate((node: HTMLImageElement) => node.naturalWidth))
            .toBeGreaterThan(0);
        }
      }
      expect(await nativeSemanticsProblems(page)).toEqual({
        redundantRoles: [],
        nonnativeControls: [],
      });
      if (isA11y()) {
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family.includes('Inter') && font.status === 'loaded'
            )
          )
        ).toBe(true);
        const { violations, incomplete } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
        expect(violations.map((violation) => violation.id)).toEqual([]);
        // A photo-backed hero is an axe contrast manual-review case (bgOverlap). Preserve
        // the result as evidence; a new kind of serious incomplete must fail this gate.
        await test.info().attach('axe-incomplete.json', {
          body: JSON.stringify(incomplete),
          contentType: 'application/json',
        });
        expect(
          incomplete
            .filter((result) => result.impact === 'serious' || result.impact === 'critical')
            .filter((result) => result.id !== 'color-contrast')
            .map((result) => result.id)
        ).toEqual([]);
      }
      expect(failed).toEqual([]);
      expect(foreign).toEqual([]);
    });

// Every locale of a page carries its own description, Open Graph tags and image alts, compared
// across the locales so a value copied from the other language fails (lib/metadata.ts).
for (const entry of entries)
  test(`${entry.slug}: description, Open Graph and alt per locale`, async ({ page }) => {
    const pages: LocaleMetadata[] = [];
    for (const [locale, identity] of Object.entries(entry.locales)) {
      await page.goto(identity.path);
      pages.push(await localeMetadata(page, locale, identity.title));
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(localeMetadataProblems(pages)).toEqual([]);
  });

// The comparison is the gate, so it must fire on what a presence check lets through.
test('locale metadata copied from another locale is a problem', () => {
  const nl: LocaleMetadata = {
    locale: 'nl',
    title: 'Schone lucht',
    description: 'Over ons werk',
    ogTitle: 'Schone lucht',
    ogDescription: 'Over ons werk',
    ogUrl: 'https://example.test/a',
    canonical: 'https://example.test/a',
    hreflang: ['nl', 'en', 'x-default'],
    alts: ['Demonstranten', ''],
  };
  const en: LocaleMetadata = {
    ...nl,
    locale: 'en',
    title: 'Clean air',
    ogTitle: 'Clean air',
    ogUrl: 'https://example.test/en/a',
    canonical: 'https://example.test/en/a',
  };
  expect(
    localeMetadataProblems([
      nl,
      { ...en, description: 'About', ogDescription: 'About', alts: ['Protesters', ''] },
    ])
  ).toEqual([]);
  expect(localeMetadataProblems([nl, en])).toEqual([
    'nl/en: same description',
    'nl/en: image 1 same alt',
  ]);
  expect(
    localeMetadataProblems([
      nl,
      { ...en, description: 'About', ogDescription: 'About', alts: ['Protesters', null] },
    ])
  ).toEqual(['en: image 2 has no alt']);
});

// Every corpus page, in each locale, comes back from the back/forward cache (lib/bfcache.ts). Its
// own browser, so one project is enough; a11y is the one with JavaScript, where an enhancement
// could add the unload handler or connection that blocks the cache.
test.describe('quality corpus back/forward cache', () => {
  let browser: Browser | undefined;
  test.beforeAll(async () => {
    onlyA11y('one browser of its own, measured once');
    browser = await bfcacheBrowser();
  });
  test.afterAll(async () => {
    await browser?.close();
  });
  const open = async (baseURL: string | undefined) => {
    const context = await browser!.newContext({
      ...(baseURL ? { baseURL } : {}),
      extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
    });
    return context.newPage();
  };

  for (const entry of entries)
    test(`${entry.slug}: back returns the page from the cache`, async ({ baseURL }) => {
      const page = await open(baseURL);
      const other = entries.find((candidate) => candidate !== entry)!;
      for (const [locale, identity] of Object.entries(entry.locales)) {
        const away = other.locales[locale as keyof typeof other.locales]!.path;
        expect(await bfcacheRestore(page, identity.path, away), locale).toEqual({
          restored: true,
          reasons: [],
        });
      }
      await page.context().close();
    });

  // The measurement must be able to fail: an unload handler is a reason every browser refuses.
  test('a page with an unload handler is not restored', async ({ baseURL }) => {
    const page = await open(baseURL);
    await page.addInitScript(() => addEventListener('unload', () => {}));
    const [entry, other] = entries;
    const outcome = await bfcacheRestore(
      page,
      Object.values(entry!.locales)[0]!.path,
      Object.values(other!.locales)[0]!.path
    );
    expect(outcome.restored).toBe(false);
    expect(outcome.reasons).toContain('UnloadHandlerExistsInMainFrame');
    await page.context().close();
  });
});

// Every corpus page fetches a link ahead on hover, under the real Content-Security-Policy, in the
// browser that keeps the cache (lib/speculation.ts); what must not be fetched ahead is not.
test.describe('quality corpus speculation rules', () => {
  let browser: Browser | undefined;
  test.beforeAll(async () => {
    onlyA11y('one browser of its own, measured once');
    browser = await bfcacheBrowser();
  });
  test.afterAll(async () => {
    await browser?.close();
  });
  const open = async (baseURL: string | undefined) => {
    const context = await browser!.newContext({
      ...(baseURL ? { baseURL } : {}),
      extraHTTPHeaders: { 'x-forwarded-proto': 'http' },
    });
    return context.newPage();
  };

  for (const entry of entries)
    test(`${entry.slug}: a held link is already there on click`, async ({ baseURL }) => {
      const page = await open(baseURL);
      const refused: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') refused.push(message.text());
      });
      const other = entries.find((candidate) => candidate !== entry)!;
      for (const [locale, identity] of Object.entries(entry.locales)) {
        const to = other.locales[locale as keyof typeof other.locales]!.path;
        expect(await arrivesFetchedAhead(page, identity.path, to), locale).toBe(true);
      }
      expect(refused).toEqual([]);
      await page.context().close();
    });

  test('a confirmation, a query or a nofollow link is not fetched ahead', async ({ baseURL }) => {
    const page = await open(baseURL);
    const [entry, other] = entries;
    const from = Object.values(entry!.locales)[0]!.path;
    const to = Object.values(other!.locales)[0]!.path;
    for (const href of ['/probe/confirm', `${to}?page=2`])
      expect(await arrivesFetchedAhead(page, from, href), href).toBe(false);
    expect(await arrivesFetchedAhead(page, from, to, { rel: 'nofollow' }), 'nofollow').toBe(false);
    await page.context().close();
  });
});

test.describe('quality corpus reflow and text spacing', () => {
  test.use({ viewport: NARROW });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: 320 CSS px, 200% text and WCAG spacing`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        await page.goto(identity.path);
        await setTextSpacing(page);
        await setTextSize(page, '200%');
        await layoutGate(page, `${entry.slug} ${locale} with WCAG text spacing`);
      });
  for (const entry of entries.filter((e) => (e.expected as { form?: boolean }).form))
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: form fields fit a phone keyboard`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        await page.goto(identity.path);
        expect(await mobileInputProblems(page)).toEqual([]);
      });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: forced colours keep shapes and focus`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        await page.emulateMedia({ forcedColors: 'active' });
        await page.goto(identity.path);
        await layoutGate(page, `${entry.slug} ${locale} in forced colours`);
        expect(await forcedColorsProblems(page)).toEqual([]);
      });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: no bar hides the keyboard focus`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        await page.goto(identity.path);
        await setTextSize(page, '200%');
        expect(await focusObscuredProblems(page)).toEqual([]);
      });
  // The public theme has no fixed or sticky bar yet, so the test above would also pass if it
  // measured nothing. A bar over the lower half of the viewport, the place a consent banner
  // takes, must hide the stops the Tab walk scrolls into view at the bottom edge.
  test('a fixed bar over the focus is caught', async ({ page }) => {
    onlyA11y('requires DOM measurements');
    const [entry] = entries;
    await page.goto(Object.values(entry!.locales)[0]!.path);
    await page.evaluate(() => {
      const bar = document.createElement('div');
      Object.assign(bar.style, {
        position: 'fixed',
        insetInline: '0',
        bottom: '0',
        height: '50vh',
      });
      document.body.append(bar);
    });
    expect((await focusObscuredProblems(page)).length).toBeGreaterThan(0);
  });
  // Both gates above trust the Tab walk to reach the end of the page. Two identical controls
  // (the same call to action twice) once ended it at the second; a control after them must
  // still be measured.
  test('the tab walk reaches the last control past identical ones', async ({ page }) => {
    onlyA11y('requires DOM measurements');
    const [entry] = entries;
    await page.goto(Object.values(entry!.locales)[0]!.path);
    await page.evaluate(() => {
      const paragraph = (tag: string, text: string) => {
        const control = document.createElement(tag);
        control.textContent = text;
        if (tag === 'a') control.setAttribute('href', '#twin');
        const p = document.createElement('p');
        p.append(control);
        return p;
      };
      document.body.prepend(paragraph('a', 'Twin'), paragraph('a', 'Twin'));
      document.body.append(paragraph('button', 'Last control'));
    });
    const names = (await tabStops(page)).map((stop) => stop.name);
    expect(names.filter((name) => name === 'Twin')).toHaveLength(2);
    expect(names.at(-1)).toBe('Last control');
  });
});

test.describe('validated demanding theme simulation', () => {
  test.use({ viewport: NARROW });
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales))
      test(`${entry.slug} ${locale}: editorial CSS keeps content and actions`, async ({ page }) => {
        onlyA11y('requires DOM measurements');
        const editorial = Theme.parse(THEME_PRESETS.editorial);
        await page.route('**/_theme/*.css', async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response, body: themeCss(editorial) });
        });
        const response = await page.goto(identity.path);
        expect(response?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(identity.title);
        await expect(page.locator('body')).toHaveCSS('font-family', /Inter/);
        await expect(page.locator('h1')).toHaveCSS('font-family', /Mycel Serif/);
        await setTextSize(page, '200%');
        await layoutGate(page, `${entry.slug} ${locale} with the editorial theme`);
        await expectNoAxeViolations(page);
      });
});

test('campaign accordion and task link work with keyboard only', async ({ page }) => {
  await page.goto(corpus.public.campaign.locales.nl.path);
  const summary = page.locator('main details summary').first();
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).toHaveAttribute('open', '');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(summary.locator('..')).not.toHaveAttribute('open', '');
  const link = page.getByRole('link', { name: 'Teken de petitie' }).first();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/probe\/signup$/);
});

// The gate items of scripts/quality/spec-checklist.json (specification.website) on the server's
// own responses: every corpus page in both locales, a revalidation, a missing path, a
// fingerprinted asset, the preloaded font and a page asked for in another language. Over the
// forwarded HTTPS scheme, as behind Caddy. The checklist file says which items are gated here,
// which an existing gate already covers and which are open.
test('public pages meet the gated items of the modern web checklist', async ({ request }) => {
  onlyA11y('reads raw HTTP responses, so one project is enough');
  const https = { 'x-forwarded-proto': 'https' };
  const sample = async (
    role: Sample['role'],
    path: string,
    headers: Record<string, string> = {},
    locale?: string
  ): Promise<Sample> => {
    const response = await request.get(path, {
      headers: { ...https, ...headers },
      maxRedirects: 0,
    });
    return {
      role,
      path,
      status: response.status(),
      headers: response.headers(),
      body: await response.text(),
      https: true,
      ...(locale ? { locale } : {}),
    };
  };
  const samples: Sample[] = [];
  for (const entry of entries)
    for (const [locale, identity] of Object.entries(entry.locales)) {
      const page = await sample('page', identity.path, {}, locale);
      samples.push(page);
      const etag = page.headers['etag'];
      if (etag)
        samples.push(await sample('revalidation', identity.path, { 'if-none-match': etag }));
      if (locale === 'nl')
        samples.push(await sample('negotiation', identity.path, { 'accept-language': 'en' }));
    }
  samples.push(await sample('missing', '/probe/spec-check-missing-page'));
  const first = samples[0]?.body ?? '';
  const asset = first.match(/href="([^"]*_app\/immutable\/[^"]+\.css)"/)?.[1];
  const font = first.match(/<link rel="preload" href="([^"]+)" as="font"/)?.[1];
  if (asset)
    samples.push(await sample('asset', new URL(asset, `http://x${samples[0]?.path}`).pathname));
  if (font) samples.push(await sample('font', font));
  samples.push(await sample('security-txt', '/.well-known/security.txt'));
  samples.push(await sample('api-catalog', '/.well-known/api-catalog'));
  expect(specFailures(checklist, samples)).toEqual([]);
});

test('admin corpus uses the populated shell, native editor and enhanced writer', async ({
  page,
  request,
}) => {
  requireApi();
  const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
    type: 'article',
    slug: corpus.public.article.slug,
  });
  expect(items).toHaveLength(1);
  const id = items[0]!.id;
  await login(page, '/admin/probe/content', qualityAdmin);
  await expect(page.locator('#content-table tbody tr')).not.toHaveCount(0);
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  expect(await nativeSemanticsProblems(page)).toEqual({
    redundantRoles: [],
    nonnativeControls: [],
  });
  await page.goto(`/admin/probe/content/${id}`);
  await expect(page.locator('#title\\.nl')).toHaveValue('De straat die ruimte maakt');
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  expect(await nativeSemanticsProblems(page)).toEqual({
    redundantRoles: [],
    nonnativeControls: [],
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.writerCspViolations = [];
    window.addEventListener('securitypolicyviolation', (event) => {
      window.writerCspViolations.push(
        `${event.violatedDirective}: ${event.blockedURI} (${event.sourceFile}:${event.lineNumber})`
      );
    });
  });
  await page.goto(`/admin/probe/content/${id}/write`);
  await expect(page.locator('.admin-site-name')).toHaveText('Probe');
  expect(await nativeSemanticsProblems(page)).toEqual({
    redundantRoles: [],
    nonnativeControls: [],
  });
  if (isA11y()) await expect(page.locator('.writing-surface .ProseMirror')).toBeVisible();
  else {
    await expect(page).toHaveURL(`/admin/probe/content/${id}#blocks`);
    await expect(page.locator('#item-edit')).toHaveCount(1);
    const prose = page.locator('[data-native-prose] details.block').first();
    await prose.locator(':scope > summary').click();
    await expect(prose.locator('textarea').first()).toBeVisible();
  }
  if (isA11y()) {
    const writing = page.locator('.writing-surface .ProseMirror');
    expect((await writing.innerText()).trim().split(/\s+/u).length).toBeGreaterThanOrEqual(
      corpus.public.article.expected.minWords
    );
    await expect(writing).toHaveAttribute('contenteditable', 'true');
    await writing.locator('.editor-prose p').first().click();
    await writing.press('ArrowRight');
    expect(await page.evaluate(() => window.writerCspViolations)).toEqual([]);
    expect(consoleErrors).toEqual([]);
  }
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('native semantics catches redundant roles and recreated simple controls', async ({ page }) => {
  await page.setContent(`<!doctype html><html lang="en"><title>Controls</title><body>
    <button id="redundant" role="button">Save</button>
    <div id="custom" role="button" tabindex="0" hidden>Save</div>
    <a id="fake-link" role="link" tabindex="0">Read</a>
    <span id="fake-check" role="checkbox" aria-checked="false" tabindex="0">Yes</span>
    <span id="fake-radio" role="radio" aria-checked="false" tabindex="0">One</span>
    <div id="fake-slider" role="slider" tabindex="0" aria-valuenow="1">Volume</div>
    <div id="fake-number" role="spinbutton" tabindex="0" aria-valuenow="1">Amount</div>
    <input id="check" type="checkbox" role="checkbox">
    <a id="link" href="/" role="link">Home</a>
    <input id="radio" type="radio" role="radio">
    <input id="slider" type="range" role="slider">
    <input id="number" type="number" role="spinbutton">
  </body></html>`);
  expect(await nativeSemanticsProblems(page)).toEqual({
    redundantRoles: [
      'button#redundant: button',
      'input#check: checkbox',
      'a#link: link',
      'input#radio: radio',
      'input#slider: slider',
      'input#number: spinbutton',
    ],
    nonnativeControls: [
      'div#custom: button',
      'a#fake-link: link',
      'span#fake-check: checkbox',
      'span#fake-radio: radio',
      'div#fake-slider: slider',
      'div#fake-number: spinbutton',
    ],
  });
  await page.setContent(`<!doctype html><html lang="en"><title>Controls</title><body>
    <button aria-expanded="false" aria-controls="more">More</button><div id="more" hidden></div>
    <input type="button" value="Save"><input type="submit"><input type="reset">
    <a href="/">Home</a><input type="checkbox"><input type="radio">
    <input type="range"><input type="number"><details><summary>More</summary>Text</details>
    <div role="status">Saved</div><button role="tab" aria-selected="true">One</button>
    <div contenteditable="true" role="textbox" aria-multiline="true" aria-label="Article"></div>
    <script type="application/json">{"example":"<div role='button'>"}</script>
    <!-- <div role="button">Example</div> -->
  </body></html>`);
  expect(await nativeSemanticsProblems(page)).toEqual({
    redundantRoles: [],
    nonnativeControls: [],
  });
});
