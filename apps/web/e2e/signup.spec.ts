// flow: consent
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expectNoAxeViolations } from './lib/axe';
import { isA11y, onlyA11y } from './lib/project';
import { postUseCase } from './lib/api';
import { pastMinimumFillTime } from './lib/form';

/**
 * A form page ships exactly one script, the proof-of-work module from its own origin (brief
 * form-intake § D2.3); nothing inline, nothing from elsewhere.
 */
async function expectOnlyProofScript(page: Page) {
  const scripts = await page
    .locator('script')
    .evaluateAll((all: HTMLScriptElement[]) =>
      all.map((s) => ({ src: s.getAttribute('src'), type: s.getAttribute('type'), inline: s.text }))
    );
  expect(scripts).toEqual([{ src: '/_form/proof.js', type: 'module', inline: '' }]);
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
  await expectOnlyProofScript(page);
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
  await expectOnlyProofScript(page);
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
