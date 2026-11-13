// flow: consent
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expectNoAxeViolations } from './lib/axe';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, postUseCase } from './lib/api';
import { pastMinimumFillTime } from './lib/form';
import { forwarded, login } from './lib/login';
import {
  NARROW,
  TEXT_SIZES,
  actionBlockProblems,
  actionBlocks,
  layoutGate,
  setTextSize,
} from './lib/layout';
import {
  BLOCK_DEFINITIONS as DEFS,
  capabilitiesFor,
  systemPrincipal,
  UseCaseError,
  useCases,
} from '@mycel/core';
import { testTenant } from '@mycel/db/testing';
import { asOwner, tenantId, withInvoker } from './lib/invoker';

/**
 * A form page ships proof of work, plus conditional display only when its definition needs it.
 * Both are exact self-hosted modules: nothing inline, nothing from elsewhere.
 */
async function expectFormScripts(page: Page) {
  const scripts = await page
    .locator('script')
    .evaluateAll((all: HTMLScriptElement[]) =>
      all.map((s) => ({ src: s.getAttribute('src'), type: s.getAttribute('type'), inline: s.text }))
    );
  const expected = [{ src: '/_form/proof.js', type: 'module', inline: '' }];
  if (await page.locator('form[data-conditions]').count())
    expected.push({ src: '/_form/conditions.js', type: 'module', inline: '' });
  expect(scripts).toEqual(expected);
}

// Playwright derives Accept-Language from `locale`; the random client address gives each run a
// fresh per-IP rate-limit bucket (see ADDRESS_HEADER in playwright.config.ts).
test.use({
  locale: 'nl-NL',
  extraHTTPHeaders: {
    'x-forwarded-proto': 'http',
    'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
  },
});

test('signup page renders from blocks without JavaScript and passes axe', async ({ page }) => {
  const response = await page.goto('/probe/signup');
  expect(response?.status()).toBe(200);
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await expect(page.getByRole('heading', { level: 1, name: 'Blijf op de hoogte' })).toBeVisible();
  await expect(
    page.getByRole('heading', { level: 2, name: 'Meld je aan voor de nieuwsbrief' })
  ).toBeVisible();
  await expectFormScripts(page);
  // The seed keeps the footer credit on (ADR 015 rule 5): a plain link, nothing else.
  await expect(
    page.getByRole('contentinfo').getByRole('link', { name: 'Draait op Mycel' })
  ).toHaveAttribute('href', 'https://mycel.dev');
  await expectNoAxeViolations(page);
});

test.describe('an English visitor of a page published in Dutch only', () => {
  test.use({ locale: 'en-GB' });

  test('gets the Dutch publication and never the English draft', async ({ page, request }) => {
    const response = await page.goto('/probe/draft-check');
    expect(response?.status()).toBe(200);
    await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
    const html = await page.content();
    expect(html).toContain('Alleen Nederlands live');
    expect(html).not.toContain('EN-DRAFT');
    // The English path of an unpublished locale is a 404, never a fallback (TODO #8c2).
    const english = await request.get('/probe/en/draft-check');
    expect(english.status()).toBe(404);
    expect(await english.text()).not.toContain('EN-DRAFT');
  });
});

/** The console mailer spools each message as JSON (scripts/e2e/e2e.mjs sets MAIL_SPOOL_DIR). */
async function waitForMail(to: string): Promise<{ text: string }> {
  const dir = process.env['MAIL_SPOOL_DIR'];
  if (!dir) throw new Error('MAIL_SPOOL_DIR is not set; run through scripts/e2e/e2e.mjs');
  await expect
    .poll(
      () =>
        readdirSync(dir).some(
          (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to.email === to
        ),
      { timeout: 15_000, message: `confirmation mail to ${to}` }
    )
    .toBe(true);
  const file = readdirSync(dir).find(
    (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to.email === to
  )!;
  return JSON.parse(readFileSync(join(dir, file), 'utf8'));
}

/** `supporter.get` over the HTTP API (scripts/e2e/e2e.mjs starts it with a key for tenant probe). */
async function supporter(
  request: APIRequestContext,
  email: string
): Promise<{ lists: string[]; pendingLists: string[] } | null> {
  const res = await postUseCase(request, 'supporter.get', { email });
  if (res.status() === 404) return null;
  expect(res.ok()).toBe(true);
  return res.json();
}

/** The confirmation link in the mail to `to`: the site's canonical address (ADR 014 rule 6). */
async function linkFor(request: APIRequestContext, to: string): Promise<string> {
  const mail = await waitForMail(to);
  await expect
    .poll(() => supporter(request, to), { timeout: 15_000 })
    .toMatchObject({ lists: [], pendingLists: ['newsletter'] });
  return /https?:\/\/\S+\/confirm\?token=\S+/.exec(mail.text)![0];
}

test('signup with double opt-in: too-fast post, thank-you page, confirmation page, one deliberate post', async ({
  page,
  request,
}) => {
  const email = `e2e-${Date.now()}@example.org`;
  await page.goto('/probe/signup');
  await page.getByLabel('E-mailadres').fill(email);
  await page.getByLabel(/nieuwsbrief ontvangen/).check();
  await page.getByRole('button', { name: 'Aanmelden' }).click();

  await expect(page).toHaveTitle(/^Fout: /);
  await expect(page.getByRole('alert')).toContainText('Dat ging erg snel');
  await expect(page.getByLabel('E-mailadres')).toHaveValue(email);
  await expectNoAxeViolations(page);

  // The re-rendered form carries a fresh timing token; wait past the minimum fill time.
  await pastMinimumFillTime(page);
  await page.getByLabel(/nieuwsbrief ontvangen/).check();
  await page.getByRole('button', { name: 'Aanmelden' }).click();

  await expect(page).toHaveURL(/\/probe\/signup\/thanks$/);
  await expect(page.getByText('Bedankt! Check je mailbox')).toBeVisible();
  await expectNoAxeViolations(page);

  // The worker ingests the signup (pending, ADR 010 rule 5) and sends the confirmation mail. The
  // link is on the site's platform hostname probe.localhost, which Chromium resolves to loopback.
  const link = await linkFor(request, email);
  expect(link.startsWith('http://probe.localhost:4173/confirm?token=')).toBe(true);
  const token = new URL(link).searchParams.get('token')!;

  // (a) A link scanner or preview fetch reads the page and confirms nothing. The route's
  // referrer policy wins over the public default (`strict-origin`, not `no-referrer`, which
  // would make the button's post `Origin: null`), and nothing is stored on the way.
  const scanned = await request.get(link);
  expect(scanned.status()).toBe(200);
  expect(scanned.headers()['cache-control']).toBe('no-store');
  expect(scanned.headers()['referrer-policy']).toBe('strict-origin');
  expect(scanned.headers()['vary']).toContain('accept-language');
  expect((await request.head(link)).status()).toBe(200);

  // (d) A post from another origin is refused before the action runs.
  const forged = await request.post('http://probe.localhost:4173/confirm', {
    headers: {
      origin: 'https://evil.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    data: `token=${encodeURIComponent(token)}`,
    maxRedirects: 0,
  });
  expect(forged.status()).toBe(403);
  expect(await supporter(request, email)).toMatchObject({
    lists: [],
    pendingLists: ['newsletter'],
  });

  // (b) The person opens the link and presses the one button: a 303 to a tokenless outcome.
  await page.goto(link);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Bevestig je inschrijving' })
  ).toBeVisible();
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Bevestig mijn inschrijving' }).click();
  await expect(page).toHaveURL(/^http:\/\/probe\.localhost:4173\/confirm\/confirmed\?locale=nl$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Inschrijving bevestigd' })
  ).toBeVisible();
  await expectNoAxeViolations(page);
  const outcome = await request.get(page.url());
  expect(outcome.headers()['cache-control']).toBe('no-store');
  expect(outcome.headers()['referrer-policy']).toBe('strict-origin');

  // (c) The link once more: it says so, without a button and without doing it again.
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1, name: 'Al bevestigd' })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expectNoAxeViolations(page);

  await expect
    .poll(() => supporter(request, email), { timeout: 15_000 })
    .toMatchObject({
      lists: ['newsletter'],
      pendingLists: [],
    });
});

test('an English signup is confirmed in English, with every script blocked', async ({
  page,
  request,
}) => {
  // (g) Nothing on the flow needs JavaScript: block every script the browser would load.
  await page.route('**/*.js', (route) => route.abort());
  const email = `e2e-en-${Date.now()}@example.org`;
  await page.goto('/probe/en/signup');
  await expectNoAxeViolations(page);
  await pastMinimumFillTime(page);
  await page.getByLabel('E-mail address').fill(email);
  await page.getByLabel(/send me the newsletter/).check();
  // (D2 b) Without the proof script the post carries an empty `_proof` and still goes through,
  // on the stricter `unproven` route.
  const posted = page.waitForRequest((r) => r.method() === 'POST');
  await page.getByRole('button', { name: 'Sign up' }).click();
  expect(new URLSearchParams((await posted).postData() ?? '').get('_proof')).toBe('');
  await expect(page).toHaveURL(/\/probe\/en\/signup\/thanks$/);

  // (e) The page speaks the language of the signup, whatever the browser asks for.
  await page.goto(await linkFor(request, email));
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Confirm your subscription' })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Confirm my subscription' }).click();
  await expect(page).toHaveURL(/\/confirm\/confirmed\?locale=en$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Subscription confirmed' })
  ).toBeVisible();
  await expect
    .poll(() => supporter(request, email), { timeout: 15_000 })
    .toMatchObject({ lists: ['newsletter'], pendingLists: [] });
});

// ADR 033: a petition from the campaigns screen to a counted, confirmed signature, with
// participation separate from publication and the server deciding at submit time (rule 3).
test('a petition: start, publish, open, sign and confirm, count one, close, stale tabs refuse', async ({
  page,
}) => {
  await login(page, '/admin/probe/campaigns');
  await page.getByRole('link', { name: 'Nieuwe campagne' }).first().click();
  const project = test.info().project.name;
  const slug = `petitie-${project}-${Date.now()}`;
  await page.getByLabel('Titel (nl)').fill(`Red het park ${slug}`);
  await page.getByLabel('Titel (en)').fill('Save the test park');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Doel').fill('500');
  await page.getByRole('button', { name: 'Campagne starten' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]+\?campaign=created#campaign$/);
  const itemId = /content\/([0-9a-f-]+)/.exec(page.url())![1]!;
  const panel = page.locator('#campaign');
  await expect(panel.getByRole('heading', { name: 'Petitie' })).toBeVisible();
  await expect(panel.getByText('Campagne gestart.')).toBeVisible();
  await expect(panel.getByText('0 van 500')).toBeVisible();

  // Publishing the page opens nothing (rule 2): the form refuses until participation opens.
  const editor = systemPrincipal(await tenantId(), 'e2e-campaign');
  await withInvoker(async (invoker) => {
    const { item } = await invoker.run(useCases.getItem, editor, { itemId });
    await invoker.run(useCases.publishItem, editor, {
      itemId,
      revisionId: item.latestRevisionId,
      locale: 'nl',
    });
  });
  const visitor = await page.context().newPage();
  const sign = async (email: string) => {
    await pastMinimumFillTime(visitor);
    await visitor.getByLabel('E-mailadres').fill(email);
    await visitor.getByRole('button', { name: 'Versturen' }).click();
  };
  await visitor.goto(`/probe/${slug}`);
  await sign(`e2e-draft-${Date.now()}@example.org`);
  await expect(
    visitor.getByText('Deze campagne neemt op dit moment geen deelname aan.')
  ).toBeVisible();

  await page.goto(`/admin/probe/content/${itemId}`);
  await panel.getByRole('button', { name: 'Deelname openen' }).click();
  await expect(panel.getByText('Deelname is open.')).toBeVisible();
  if (isA11y()) {
    await expectNoAxeViolations(page, { label: 'campaign panel' });
    await page.setViewportSize(NARROW);
    for (const size of ['100%', '200%']) {
      await setTextSize(page, size);
      await layoutGate(page, `campaign panel at ${size}`, '#campaign');
    }
    await setTextSize(page, '16px');
  }

  // Signed without consent and without JavaScript in the no-js project: the thanks and the
  // confirmation speak of taking part, never of a subscription (B2 review R1).
  const email = `e2e-petition-${Date.now()}@example.org`;
  await visitor.goto(`/probe/${slug}`);
  await sign(email);
  await expect(visitor.getByText('bevestig je handtekening')).toBeVisible();
  const link = /https?:\/\/\S+\/confirm\?token=\S+/.exec((await waitForMail(email)).text)![0];
  await visitor.goto(link);
  await expect(
    visitor.getByRole('heading', { level: 1, name: 'Bevestig je deelname' })
  ).toBeVisible();
  await visitor.getByRole('button', { name: 'Bevestig mijn deelname' }).click();
  await expect(visitor).toHaveURL(/\/confirm\/confirmed\?locale=nl&purpose=participation$/);
  await expect(
    visitor.getByRole('heading', { level: 1, name: 'Deelname bevestigd' })
  ).toBeVisible();

  // The worker records the confirmed signature; the panel counts it.
  await expect(async () => {
    await page.goto(`/admin/probe/content/${itemId}`);
    await expect(panel.getByText('1 van 500')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });

  // Two tabs from before the close: the public form and the panel on the old base.
  await visitor.goto(`/probe/${slug}`);
  const stale = await page.context().newPage();
  await stale.goto(`/admin/probe/content/${itemId}`);
  await panel.getByRole('button', { name: 'Deelname sluiten' }).click();
  await expect(panel.getByText('Deelname is gesloten.')).toBeVisible();
  await sign(`e2e-late-${Date.now()}@example.org`);
  await expect(
    visitor.getByText('Deze campagne neemt op dit moment geen deelname aan.')
  ).toBeVisible();
  await stale.locator('#campaign').getByRole('button', { name: 'Campagne opslaan' }).click();
  await expect(stale).toHaveURL(/\?campaign=conflict#campaign$/);
  await expect(
    stale.getByText('Iemand anders heeft deze campagne intussen gewijzigd.')
  ).toBeVisible();

  // The list under Content shows it, published, closed, with its count.
  await page.goto('/admin/probe/campaigns');
  const row = page.getByRole('row', { name: new RegExp(`Red het park ${slug}`) });
  await expect(row).toContainText('Gesloten');
  await expect(row).toContainText('Gepubliceerd (nl)');
  await expect(row).toContainText('1 van 500');
});

test.describe('in English', () => {
  // A Dutch browser on the English path: the path decides, not Accept-Language.
  test.use({ locale: 'nl-NL' });

  test('the English path serves English (the path is the locale, TODO #8c2)', async ({ page }) => {
    await page.goto('/probe/en/signup');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: 'Stay informed' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign up' })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test('an invalid confirmation link explains itself and passes axe', async ({ page, request }) => {
  await page.goto('/probe/confirm?token=forged');
  await expect(page.getByRole('heading', { level: 1, name: 'Deze link werkt niet' })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
  await expectNoAxeViolations(page);
  // A forged post lands on the tokenless invalid page; an unknown outcome is a 404.
  await page.goto('/probe/confirm/invalid');
  await expect(page.getByRole('heading', { level: 1, name: 'Deze link werkt niet' })).toBeVisible();
  expect((await request.get('/probe/confirm/whatever')).status()).toBe(404);
});

// TODO #20c: the response headers and the CSP of a public page, the nonce mode on a page that
// does ship SvelteKit's inline bootstrap (the root placeholder, the one route with `csr` on),
// and the origin check on the public form. Each would fail if the boundary were taken away.
const STRICT_CSP = [
  "default-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "require-trusted-types-for 'script'",
  'report-to default',
];

/** Navigates to `path` and collects the CSP violations Chromium reports on the console. */
async function gotoWatchingCsp(page: Page, path: string): Promise<[Response, string[]]> {
  const seen: string[] = [];
  const listen = (msg: { text(): string }) => {
    if (/Content Security Policy/i.test(msg.text())) seen.push(msg.text());
  };
  page.on('console', listen);
  const response = await page.goto(path);
  await page.waitForLoadState('networkidle');
  page.off('console', listen);
  return [response!, seen];
}

test('a public page has the security headers and a strict CSP, and only its own form script', async ({
  page,
}) => {
  const [response, violations] = await gotoWatchingCsp(page, '/probe/signup');
  const headers = response.headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toBe(
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  );
  // Plain HTTP here (x-forwarded-proto), so no HSTS.
  expect(headers['strict-transport-security']).toBeUndefined();
  const csp = headers['content-security-policy']!;
  for (const directive of STRICT_CSP) expect(csp).toContain(directive);
  expect(csp).toMatch(/script-src 'self'(;|$)/);
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  await expectFormScripts(page);
  // With JavaScript, the script ran under that policy (it fills the field) and reported nothing.
  if (isA11y())
    await expect(page.locator('input[name="_proof"]')).not.toHaveValue('', { timeout: 10_000 });
  expect(await page.locator('[style]').count()).toBe(0);
  expect(violations).toEqual([]);
  await expectNoAxeViolations(page);
});

test('inline bootstrap runs on its per-response nonce, and only on that', async ({ page }) => {
  const nonceOf = (csp: string | undefined) => /'nonce-([^']+)'/.exec(csp ?? '')?.[1];
  const [first, violations] = await gotoWatchingCsp(page, '/');
  const nonce = nonceOf(first.headers()['content-security-policy']);
  expect(nonce).toBeTruthy();
  expect(first.headers()['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
  const inline = page.locator('script:not([src])');
  expect(await inline.count()).toBeGreaterThan(0);
  for (const script of await inline.all())
    expect(await script.evaluate((s) => (s as HTMLScriptElement).nonce)).toBe(nonce);
  // With JavaScript on (a11y project) the bootstrap actually executes under the policy.
  expect(violations).toEqual([]);

  const second = await page.request.get('/');
  const again = nonceOf(second.headers()['content-security-policy']);
  expect(again).toBeTruthy();
  expect(again).not.toBe(nonce);
});

test('a form post from another origin is refused, from its own origin it is not', async ({
  request,
  baseURL,
}) => {
  const post = (origin: string) =>
    request.post('/probe/signup', {
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      data: 'email=x%40example.org',
      maxRedirects: 0,
    });
  expect((await post('https://evil.example')).status()).toBe(403);
  expect((await post(baseURL!)).status()).not.toBe(403);
});

// Brief form-intake (TODO #22D1 + #30A): what happens after a post, against the real stack.

/** The hidden fields of the first form in `html`. */
function formFields(html: string): { formId: string; started: string } {
  const value = (name: string) =>
    new RegExp(`name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ??
    new RegExp(`value="([^"]*)"[^>]*name="${name}"`).exec(html)![1]!;
  return { formId: value('formId'), started: value('_started') };
}

/** A native form post from this origin, from a client address of its own (a fresh IP bucket). */
function postForm(
  request: APIRequestContext,
  baseURL: string,
  fields: Record<string, string>,
  ip: string
) {
  return request.post('/probe/signup', {
    headers: {
      origin: baseURL,
      accept: 'text/html',
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': ip,
    },
    data: new URLSearchParams(fields).toString(),
    maxRedirects: 0,
  });
}

const freshIp = () => `203.0.113.${Math.floor(Math.random() * 250) + 1}`;

/** How many spooled mails went to `to`. */
function mailsTo(to: string): number {
  const dir = process.env['MAIL_SPOOL_DIR']!;
  return readdirSync(dir).filter(
    (f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).to.email === to
  ).length;
}

test('five signups of one address within a day give five thank-you pages and one mail', async ({
  request,
  baseURL,
}) => {
  // (e) The bomb: one GET, the minimum fill time, five posts with the same address.
  const email = `e2e-bomb-${Date.now()}@example.org`;
  const { formId, started } = formFields(await (await request.get('/probe/signup')).text());
  await new Promise((r) => setTimeout(r, 3200));
  // Without a proof, like a browser without JavaScript; each post from its own address, so the
  // stricter `unproven` bucket (three an hour) is not what stops posts two to five.
  for (let i = 0; i < 5; i++) {
    const res = await postForm(
      request,
      baseURL!,
      { formId, _started: started, website: '', email, consent: 'on' },
      freshIp()
    );
    expect(res.status(), `post ${i + 1}`).toBe(303);
    expect(res.headers()['location']).toBe('/probe/signup/thanks');
  }
  await waitForMail(email);
  // The worker drains the outbox every few seconds: give a second mail the time to show up.
  await expect
    .poll(() => supporter(request, email), { timeout: 15_000 })
    .toMatchObject({ pendingLists: ['newsletter'] });
  await new Promise((r) => setTimeout(r, 3000));
  expect(mailsTo(email)).toBe(1);
});

test('a form page is no-store without an ETag, and revalidation gives a fresh token', async ({
  request,
  baseURL,
}) => {
  // (f) #30A: no shared copy keeps an old timing token alive.
  const first = await request.get('/probe/signup');
  expect(first.headers()['cache-control']).toBe('no-store');
  expect(first.headers()['etag']).toBeUndefined();
  const head = await request.head('/probe/signup');
  expect(head.headers()['cache-control']).toBe('no-store');
  expect(head.headers()['etag']).toBeUndefined();

  await new Promise((r) => setTimeout(r, 1100));
  const second = await request.get('/probe/signup', { headers: { 'if-none-match': '*' } });
  expect(second.status()).toBe(200);
  const a = formFields(await first.text());
  const b = formFields(await second.text());
  expect(b.started).not.toBe(a.started);

  await new Promise((r) => setTimeout(r, 3200));
  const email = `e2e-fresh-${Date.now()}@example.org`;
  const res = await postForm(
    request,
    baseURL!,
    { formId: b.formId, _started: b.started, website: '', email, consent: 'on' },
    freshIp()
  );
  expect(res.headers()['location']).toBe('/probe/signup/thanks');
  await waitForMail(email);
});

test('the honeypot is out of reach of password managers, and a post without it is refused', async ({
  page,
  request,
  baseURL,
}) => {
  // (g) The four attributes the managers read.
  await page.goto('/probe/signup');
  const hp = page.locator('input[name="website"]');
  await expect(hp).toHaveAttribute('data-1p-ignore', '');
  await expect(hp).toHaveAttribute('data-lpignore', 'true');
  await expect(hp).toHaveAttribute('data-bwignore', '');
  await expect(hp).toHaveAttribute('data-form-type', 'other');

  // (h) No `website` field at all: the same thank-you page, no submission, no mail.
  const { formId, started } = formFields(await page.content());
  await pastMinimumFillTime(started);
  const ip = freshIp();
  const bot = `e2e-nohp-${Date.now()}@example.org`;
  const refused = await postForm(
    request,
    baseURL!,
    { formId, _started: started, email: bot, consent: 'on' },
    ip
  );
  expect(refused.headers()['location']).toBe('/probe/signup/thanks');
  // A person right after, through the same worker: once their mail is there, the bot's would be.
  const person = `e2e-hp-${Date.now()}@example.org`;
  await postForm(
    request,
    baseURL!,
    { formId, _started: started, website: '', email: person, consent: 'on' },
    ip
  );
  await waitForMail(person);
  expect(mailsTo(bot)).toBe(0);
  expect(await supporter(request, bot)).toBeNull();
});

// Brief form-intake § D2.4: ALTCHA proof of work, with a stricter route instead of a wall.

/** The `data-proof` challenge of the first form in `html`, and its solution as `_proof`. */
function solveFrom(html: string): string {
  const attr = /data-proof='([^']*)'|data-proof="([^"]*)"/.exec(html)!;
  const raw = (attr[1] ?? attr[2]!).replaceAll('&quot;', '"').replaceAll('&#39;', "'");
  const c = JSON.parse(raw) as { challenge: string; salt: string; maxNumber: number };
  for (let n = 0; n <= c.maxNumber; n++)
    if (createHash('sha256').update(`${c.salt}${n}`).digest('hex') === c.challenge)
      return btoa(JSON.stringify({ ...c, number: n, maxNumber: undefined }));
  throw new Error('no solution');
}

test('with JavaScript the post carries a solved proof, and the policy reports nothing', async ({
  page,
  request,
}) => {
  onlyA11y('the proof script needs JavaScript');
  // (a) The ordinary flow: the script solves while the visitor types.
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  const email = `e2e-proof-${Date.now()}@example.org`;
  await page.goto('/probe/signup');
  await pastMinimumFillTime(page);
  await page.getByLabel('E-mailadres').fill(email);
  await page.getByLabel(/nieuwsbrief ontvangen/).check();
  const posted = page.waitForRequest((r) => r.method() === 'POST');
  await page.getByRole('button', { name: 'Aanmelden' }).click();
  const proof = new URLSearchParams((await posted).postData() ?? '').get('_proof') ?? '';
  expect(JSON.parse(atob(proof))).toMatchObject({
    algorithm: 'SHA-256',
    number: expect.any(Number),
  });
  await expect(page).toHaveURL(/\/probe\/signup\/thanks$/);
  await waitForMail(email);
  expect(violations).toEqual([]);
  expect(await supporter(request, email)).toMatchObject({ pendingLists: ['newsletter'] });
});

test('a replayed proof with a fresh token gets the thank-you page and no mail', async ({
  request,
  baseURL,
}) => {
  // (d) One solution, two posts: the second is spam, silently.
  const first = await (await request.get('/probe/signup')).text();
  const proof = solveFrom(first);
  const { formId, started } = formFields(first);
  await new Promise((r) => setTimeout(r, 3200));
  const ip = freshIp();
  const original = `e2e-proof-a-${Date.now()}@example.org`;
  const res = await postForm(
    request,
    baseURL!,
    { formId, _started: started, _proof: proof, website: '', email: original, consent: 'on' },
    ip
  );
  expect(res.headers()['location']).toBe('/probe/signup/thanks');
  await waitForMail(original);

  const fresh = formFields(await (await request.get('/probe/signup')).text());
  await new Promise((r) => setTimeout(r, 3200));
  const replay = `e2e-proof-b-${Date.now()}@example.org`;
  const replayed = await postForm(
    request,
    baseURL!,
    { formId, _started: fresh.started, _proof: proof, website: '', email: replay, consent: 'on' },
    ip
  );
  expect(replayed.status()).toBe(303);
  expect(replayed.headers()['location']).toBe('/probe/signup/thanks');
  // A person right after through the same worker: once their mail is there, the replay's would be.
  const person = `e2e-proof-c-${Date.now()}@example.org`;
  await postForm(
    request,
    baseURL!,
    { formId, _started: fresh.started, website: '', email: person, consent: 'on' },
    ip
  );
  await waitForMail(person);
  expect(mailsTo(replay)).toBe(0);
  expect(await supporter(request, replay)).toBeNull();
});

test('conditional fields validate natively and forged inactive consent creates no signup', async ({
  page,
  request,
}, testInfo) => {
  await page.context().setExtraHTTPHeaders(forwarded());
  await page.goto('/probe/signup');
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'conditional form at 320px / 200%', 'main');
  await testInfo.attach('conditional-form-320-200', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  const email = `conditional-${testInfo.project.name}-${Date.now()}@example.org`;
  await page.getByLabel('E-mailadres', { exact: true }).fill(email);
  await page.getByLabel('Alleen een bericht sturen, geen nieuwsbrief').check();
  await page.getByLabel('Onderwerp', { exact: true }).selectOption('question');
  if (isA11y()) {
    await expect(page.getByLabel('Je vraag', { exact: true })).toHaveAttribute('required', '');
    await expect(page.locator('[name=consent]')).toBeDisabled();
    await expect(page.locator('[name=consent]')).toBeHidden();
  } else {
    // Without enhancement the server enforces the conditional requirement after the native post.
    await expect(page.getByLabel('Je vraag', { exact: true })).not.toHaveAttribute('required');
    await pastMinimumFillTime(page);
    await page.getByRole('button', { name: 'Aanmelden', exact: true }).click();
    await expect(page.locator('.error-summary')).toContainText('Dit veld is verplicht.');
    await expectNoAxeViolations(page);
  }
  await page.getByLabel('Je vraag', { exact: true }).fill('Kan ik langskomen?');
  await page.getByLabel('Interesses', { exact: true }).selectOption(['local', 'events']);
  // A forged checkbox is present in the POST but inactive according to validated contact_only.
  if (isA11y())
    await page.locator('[name=consent]').evaluate((input: HTMLInputElement) => {
      input.disabled = false;
      input.checked = true;
    });
  else await page.getByLabel('Ja, ik wil de nieuwsbrief ontvangen.', { exact: false }).check();
  await pastMinimumFillTime(page);
  await page.getByRole('button', { name: 'Aanmelden', exact: true }).click();
  await expect(page).toHaveURL(/signup\/thanks$/);
  expect(await supporter(request, email)).toBeNull();
});

// How long a site keeps what visitors sent (docs/reference/jobs.md § Retention): a site
// administrator sees and changes the term on a native form (the no-js project proves it without
// JavaScript); a stale save is a conflict, and an editor neither sees the section nor may post it. A site of its own: a shorter term on Probe would let
// the daily run delete the submissions other specs make there.
test('an administrator sets how long submissions are kept; an editor cannot', async ({
  page,
  baseURL,
}) => {
  const project = test.info().project.name;
  const slug = `site-retention-${project}`;
  const admin = `site-retention-${project}@probe.test`;
  const editor = `site-retention-editor-${project}@probe.test`;
  const tenant = await asOwner((owner) =>
    testTenant(owner, slug, {
      name: 'Retention',
      locales: ['nl'],
      platformDomain: process.env['PLATFORM_DOMAIN']!,
      reuse: true,
    })
  );
  const system = systemPrincipal(tenant.id, 'e2e');
  const stored = () => withInvoker((invoker) => invoker.run(useCases.getSiteRetention, system, {}));
  const setMonths = async (submissionMonths: number) => {
    const { version } = await stored();
    await withInvoker((invoker) =>
      invoker.run(useCases.updateSiteRetention, system, {
        baseVersion: version,
        retention: { submissionMonths },
      })
    );
  };
  await withInvoker(async (invoker) => {
    for (const [email, capabilities] of [
      [admin, ['tenant:admin']],
      [editor, capabilitiesFor('editor')],
    ] as const)
      try {
        await invoker.run(useCases.inviteMember, system, {
          email,
          capabilities: [...capabilities],
        });
      } catch (e) {
        if (!(e instanceof UseCaseError && e.code === 'conflict')) throw e;
      }
  });
  await setMonths(24);
  const section = page.getByRole('region', { name: 'Inzendingen bewaren' });
  try {
    await login(page, `/admin/${slug}/site`, admin);
    await expect(
      page.getByRole('heading', { level: 2, name: 'Inzendingen bewaren' })
    ).toBeVisible();
    await expect(section).toContainText('Deze site bewaart formulierinzendingen 24 maanden.');
    await expect(section).toContainText('bij de volgende dagelijkse run');
    await expectNoAxeViolations(page);

    await page.getByLabel('Bewaartermijn').selectOption('6');
    await section.getByRole('button', { name: 'Termijn opslaan' }).click();
    await expect(section).toContainText('Instellingen opgeslagen.');
    await expect(section).toContainText('Deze site bewaart formulierinzendingen 6 maanden.');
    expect((await stored()).value.submissionMonths).toBe(6);

    // Another save after this page loaded: the form's version is stale, nothing is written.
    await page.goto(`/admin/${slug}/site`);
    await setMonths(12);
    await page.getByLabel('Bewaartermijn').selectOption('1');
    await section.getByRole('button', { name: 'Termijn opslaan' }).click();
    await expect(page.getByText('Deze instellingen zijn elders gewijzigd')).toBeVisible();
    expect((await stored()).value.submissionMonths).toBe(12);
    await expectNoAxeViolations(page);

    // An editor writes content, not retention: no section, and a post by hand is refused.
    await page.context().clearCookies();
    await login(page, `/admin/${slug}/site`, editor);
    await expect(page.getByRole('heading', { level: 2, name: 'Tijdzone' })).toBeVisible();
    await expect(section).toHaveCount(0);
    const post = await page.request.post(`/admin/${slug}/site?section=general&/retention`, {
      headers: { origin: baseURL!, 'content-type': 'application/x-www-form-urlencoded' },
      data: `baseVersion=${(await stored()).version}&submissionMonths=1`,
      maxRedirects: 0,
    });
    expect(post.status()).toBe(403);
    expect((await stored()).value.submissionMonths).toBe(12);
  } finally {
    await setMonths(24);
  }
});

// Every hero, CTA and form variant and width between prose (actionBlocks in lib/layout), measured
// against the page's own rails. Here because a form block is this flow's way in; the page stays
// in probe like the text and media pages do.
test.describe('hero, CTA and form keep their rails', () => {
  test.beforeAll(async ({ request }) => {
    onlyA11y('composition measurements run in a11y');
    const slug = 'grid-actions-v1';
    if ((await callApi(request, 'content.item.list', { type: 'page', slug })).items.length) return;
    const principal = systemPrincipal(await tenantId(), 'e2e');
    const forms: string[] = [];
    for (let i = 0; i < 3; i++)
      forms.push((await callApi(request, 'form.create', { kind: 'contact' })).id);
    await withInvoker(async (invoker, uow) => {
      const [signup] = (
        await invoker.run(useCases.listItems, principal, { type: 'page', slug: 'signup' })
      ).items;
      const { revision } = await invoker.run(useCases.getItem, principal, { itemId: signup!.id });
      forms.push(
        revision.document.blocks.flatMap((b) =>
          'formId' in b.props ? [b.props.formId as string] : []
        )[0]!
      );
      const [image] = await uow.run(principal, (ctx) =>
        ctx.media.list({ q: 'malieveld.jpg', limit: 1 })
      );
      const v = (type: keyof typeof DEFS) => DEFS[type].version;
      const created = await callApi(request, 'content.item.create', {
        slug,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Oproep, actie en formulier', en: 'Hero, action and form' },
          blocks: actionBlocks(image!.id, forms as [string, string, string, string], {
            hero: v('hero'),
            cta: v('cta'),
            form: v('form'),
            'signup-form': v('signup-form'),
            'rich-text': v('rich-text'),
          }),
        },
      });
      for (const locale of ['nl', 'en'])
        await invoker.run(useCases.publishItem, principal, {
          itemId: created.item.id,
          revisionId: created.revision.id,
          locale,
        });
    });
  });

  for (const locale of ['nl', 'en'])
    for (const width of [320, 768, 1440])
      for (const size of TEXT_SIZES)
        test(`${locale} at ${width}px and ${size} text`, async ({ page }, info) => {
          onlyA11y('DOM measurements');
          await page.setViewportSize({ width, height: 900 });
          const route = `/probe/${locale === 'en' ? 'en/' : ''}grid-actions-v1`;
          expect((await page.goto(route))?.status()).toBe(200);
          await setTextSize(page, size);
          await page.evaluate(() => document.fonts.ready);
          // The whole page as evidence for the visual judgement (crop, contrast, rhythm).
          const path = info.outputPath('page.png');
          await page.screenshot({ path, fullPage: true });
          await info.attach('page', { path, contentType: 'image/png' });
          expect(await actionBlockProblems(page)).toEqual([]);
          await layoutGate(page, `${width}px ${size}`, 'main');
          if (width === 1440 && size === '100%') await expectNoAxeViolations(page);
        });
});
