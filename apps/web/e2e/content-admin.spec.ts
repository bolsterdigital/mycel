// Content admin (TODO #11, brief content-editor § A1): an operator makes a page in two locales,
// edits it, reads its revisions and their diff, and opens a preview that the public site never
// serves. A save on an outdated revision is a conflict that keeps what was typed. The admin and
// the preview ship no script (`csr = false`), so the `no-js` project is the no-JavaScript proof;
// the `a11y` project runs axe on every page and the UI gate (skill ui-action-layout).
//
// Tenant isolation of the item itself is the database's (RLS on content_items, asserted by
// rls.conformance); here the preview routes prove that a session without a membership of the
// site gets nothing, not even the theme.

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const SITE = 'http://probe.localhost:4173';
const ADMIN = 'e2e-admin@probe.test';

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

async function login(page: Page, email: string, path: string) {
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/?]/g, '\\$&')}$`));
}

const address = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

/** Another browser, as the test's own: same origin, headers and JavaScript setting. */
const freshContext = (
  browser: Browser,
  locale = 'nl-NL',
  viewport?: { width: number; height: number }
) =>
  browser.newContext({
    locale,
    ...(viewport ? { viewport } : {}),
    javaScriptEnabled: test.info().project.name === 'a11y',
    baseURL: 'http://127.0.0.1:4173',
    extraHTTPHeaders: { 'x-forwarded-proto': 'http', 'x-forwarded-for': address() },
  });

const slugFor = (what: string) =>
  `a1-${what}-${test.info().project.name}-${Date.now()}`.toLowerCase();

/** Make a page in nl and en through the "new" form; returns its edit URL. */
async function newPage(page: Page, slug: string, title: string): Promise<string> {
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Titel (nl)').fill(title);
  await page.getByLabel('Titel (en)').fill(`${title} (en)`);
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

test('an operator makes a page, edits it, and compares its revisions', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe');
  await page.getByRole('link', { name: 'Pagina’s en artikelen' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Pagina’s en artikelen' })
  ).toBeVisible();
  expect(await page.locator('script').count()).toBe(0);
  await expectNoAxeViolations(page);

  await page.getByRole('link', { name: 'Nieuwe pagina of artikel' }).click();
  await expectNoAxeViolations(page);
  const slug = slugFor('edit');
  const edit = await newPage(page, slug, 'Over de buurt');
  await expect(page.getByRole('heading', { level: 1, name: 'Over de buurt' })).toBeVisible();
  await expect(page.getByText('nl: concept')).toBeVisible();
  await expectNoAxeViolations(page);

  await page.getByLabel('Titel (nl)').fill('Over onze buurt');
  await page.getByLabel('Titel in zoekresultaten (nl)').fill('De buurt');
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(`${edit}?saved`);
  await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Over onze buurt');

  await page.getByRole('link', { name: 'Revisies', exact: true }).click();
  const revisions = page.locator('ol.revisions > li');
  await expect(revisions).toHaveCount(2);
  await expect(revisions.first()).toContainText(ADMIN);
  await expect(revisions.first()).toContainText('nieuwste');
  await page.getByRole('button', { name: 'Vergelijken' }).click();
  const diff = page.getByRole('region', { name: 'Wijzigingen' });
  await expect(diff.getByRole('row', { name: /title\.nl/ })).toContainText('Over onze buurt');
  await expect(diff.getByRole('row', { name: /seo\.title/ })).toBeVisible();
  await expectNoAxeViolations(page);

  // In the list: the new page, as a draft in both locales.
  await page.goto('/admin/probe/content?type=page');
  const card = page.locator('.content-list > li', { hasText: `/${slug}` });
  await expect(card).toContainText('nl: concept');
  await expect(card).toContainText('en: concept');
});

test('the preview shows a draft that the site does not serve', async ({ page, request }) => {
  await login(page, ADMIN, '/admin/probe');
  const slug = slugFor('preview');
  await newPage(page, slug, 'Nog geheim');

  const link = page.getByRole('link', { name: 'Voorbeeld (en), opent een nieuw tabblad' });
  await expect(link).toHaveAttribute('target', '_blank');
  const href = (await link.getAttribute('href'))!;
  const response = await page.goto(href);
  expect(response!.status()).toBe(200);
  expect(response!.headers()['cache-control']).toBe('private, no-store');
  expect(response!.headers()['x-robots-tag']).toBe('noindex');
  await expect(page.getByRole('heading', { level: 1, name: 'Nog geheim (en)' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Voorbeeld' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  expect(await page.locator('script').count()).toBe(0);
  // The site's own stylesheet, served on the admin origin to members only.
  const css = await page
    .locator('link[rel="stylesheet"][href*="/preview/_theme/"]')
    .getAttribute('href');
  expect((await page.request.get(css!)).status()).toBe(200);
  await expectNoAxeViolations(page);

  // A draft is never public: not on the site, not on the read route.
  expect((await request.get(`${SITE}/${slug}`)).status()).toBe(404);
  expect((await request.get(`${SITE}/en/${slug}`)).status()).toBe(404);

  // Without a session: to the login. Without a membership of this site: nothing.
  const anonymous = await request.get(href, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(303);
  expect(anonymous.headers()['location']).toMatch(/^\/admin\/login\?return=/);
  await stranger(page.context().browser()!, async (other) => {
    expect((await other.goto(href))!.status()).toBe(403);
    expect((await other.request.get(css!)).status()).toBe(403);
  });
});

/** A second browser context logged in as an operator without a membership of probe. */
async function stranger(browser: Browser, fn: (page: Page) => Promise<void>) {
  const context = await freshContext(browser);
  const page = await context.newPage();
  await login(page, 'nobody@probe.test', '/admin');
  await fn(page);
  await context.close();
}

test('a save on an outdated revision is a conflict that keeps what was typed', async ({
  page,
  browser,
}) => {
  await login(page, ADMIN, '/admin/probe');
  const edit = await newPage(page, slugFor('conflict'), 'Eerste versie');

  // A second editor opens the same revision and saves first.
  const context = await freshContext(browser);
  const other = await context.newPage();
  await login(other, ADMIN, edit);
  await page.getByLabel('Titel (nl)').fill('Mijn versie');
  await other.getByLabel('Titel (nl)').fill('Hun versie');
  await other.getByRole('button', { name: 'Opslaan' }).click();
  await expect(other).toHaveURL(`${edit}?saved`);
  await context.close();

  await page.getByRole('button', { name: 'Opslaan' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('Iemand anders heeft dit item intussen opgeslagen');
  await expect(alert).toContainText(ADMIN);
  await expect(alert.getByRole('row', { name: /title\.nl/ })).toContainText('Hun versie');
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mijn versie');
  await expectNoAxeViolations(page);

  // Saving again is a deliberate choice on top of the newest revision.
  await page.getByRole('button', { name: 'Opslaan' }).click();
  await expect(page).toHaveURL(`${edit}?saved`);
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mijn versie');
});

test('a reserved slug comes back as a message with what was typed', async ({ page }) => {
  await login(page, ADMIN, '/admin/probe/content/new');
  await page.getByLabel('Slug').fill('admin');
  await page.getByLabel('Titel (nl)').fill('Mag niet');
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page.getByRole('alert')).toContainText('De site gebruikt deze slug zelf');
  await expect(page.getByLabel('Titel (nl)')).toHaveValue('Mag niet');
  await expectNoAxeViolations(page);
});

test.describe('UI gate: the content admin at 320 CSS px and 200% text', () => {
  test.use({ viewport: { width: 320, height: 900 } });

  for (const locale of ['nl-NL', 'en-GB'])
    for (const text of ['100%', '200%'])
      test(`every control whole and no horizontal scroll, ${locale}, text ${text}`, async ({
        browser,
      }) => {
        test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
        const context = await freshContext(browser, locale, { width: 320, height: 900 });
        const page = await context.newPage();
        await login(page, ADMIN, '/admin/probe');
        const edit = await newPageIn(
          page,
          locale,
          slugFor(`gate-${locale}-${text.replace('%', '')}`)
        );
        for (const path of [
          edit,
          `${edit}/revisions`,
          '/admin/probe/content?type=page',
          '/admin/probe/content/new',
        ]) {
          await page.goto(path);
          if (text !== '100%')
            await page.evaluate((size) => (document.documentElement.style.fontSize = size), text);
          const problems = await page.evaluate(layoutProblems);
          if (path === edit)
            await page.locator('form .actions').screenshot({
              path: test
                .info()
                .outputPath(`content-edit-320-${locale}-${text.replace('%', '')}.png`),
            });
          expect(problems, path).toEqual([]);
        }
        await context.close();
      });
});

/** `newPage` in either admin language. */
async function newPageIn(page: Page, locale: string, slug: string): Promise<string> {
  const nl = locale.startsWith('nl');
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel(nl ? 'Titel (nl)' : 'Title (nl)').fill('Poort');
  await page.getByRole('button', { name: nl ? 'Concept maken' : 'Create draft' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** The checks of the media gate (media.spec.ts), over every action on the page. */
function layoutProblems(): string[] {
  const out: string[] = [];
  const width = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > width) {
    out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${width}`);
    for (const el of document.querySelectorAll('body *'))
      if (el.getBoundingClientRect().right > width + 1 && el.children.length === 0)
        out.push(
          `past the edge: <${el.tagName.toLowerCase()}> ${el.textContent?.trim().slice(0, 40)}`
        );
  }
  for (const b of document.querySelectorAll('button, a.button')) {
    const r = b.getBoundingClientRect();
    const label = b.textContent?.trim() ?? '';
    if (b.scrollWidth > b.clientWidth + 1) out.push(`clipped: ${label}`);
    if (r.right > width + 1 || r.left < -1) out.push(`outside the viewport: ${label}`);
    if (r.height < 44 || r.width < 44) out.push(`tap target under 44px: ${label}`);
  }
  for (const l of document.querySelectorAll('.card label, .card legend')) {
    const card = l.closest('.card')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(l);
    if (range.getBoundingClientRect().right > card.right + 1)
      out.push(`past its card: ${l.textContent?.trim()}`);
  }
  return out;
}
