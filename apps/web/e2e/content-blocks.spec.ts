// Block forms of the content admin (TODO #11, brief content-editor § B): every block type is
// edited once through its generated form, and a block is inserted, moved and removed, all with
// native forms. The admin ships no script, so the `no-js` project is the no-JavaScript proof and
// the `a11y` project runs axe and the UI gate (skill ui-action-layout). Each project edits its own
// seeded page (`e2e-blokken-<project>`, scripts/e2e.mjs) with the first example of every type, so
// the bulk fixture is seeded once and not made here (the audit log status.spec.ts reads).

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const ADMIN = 'e2e-admin@probe.test';

async function expectNoAxeViolations(page: Page) {
  if (test.info().project.name !== 'a11y') return;
  const { violations } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  expect(
    violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)
  ).toEqual([]);
}

test.use({ locale: 'nl-NL' });

async function login(page: Page, path: string) {
  // A fresh address per login: the admin allows twenty logins per address in ten minutes.
  const ip = `2001:db8::b:${Math.floor(Math.random() * 0xffff).toString(16)}`;
  await page.context().setExtraHTTPHeaders({ 'x-forwarded-proto': 'http', 'x-forwarded-for': ip });
  await page.goto(path);
  await expect(page.getByRole('heading', { name: 'Mock IdP' })).toBeVisible();
  await page.getByLabel('E-mail').fill(ADMIN);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(new RegExp(`${path.replace(/[/?]/g, '\\$&')}$`));
}

/** The seeded page of this project, by slug over the HTTP API. */
async function seededPage(request: APIRequestContext): Promise<string> {
  const slug = `e2e-blokken-${test.info().project.name}`;
  const res = await request.post(`${process.env['E2E_API_URL']}/v1/content.item.list`, {
    headers: { authorization: `Bearer ${process.env['MYCEL_API_KEY']}` },
    data: { type: 'page', slug },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const { items } = (await res.json()) as { items: { id: string }[] };
  expect(items, `${slug} is seeded by scripts/e2e.mjs`).toHaveLength(1);
  return `/admin/probe/content/${items[0]!.id}`;
}

/** Block `n` (1-based) of the edit page, opened. */
async function block(page: Page, n: number): Promise<Locator> {
  const details = page.locator('details.block').nth(n - 1);
  if ((await details.getAttribute('open')) === null)
    await details.locator(':scope > summary').click();
  return details;
}

/** Save block `n` and wait for the edit page to come back with it open. */
async function save(page: Page, n: number) {
  await (await block(page, n)).getByRole('button', { name: 'Blok opslaan' }).click();
  await expect(page).toHaveURL(/\?done=blockSaved&block=/);
  await expect(page.getByRole('status')).toContainText('Blok opgeslagen.');
}

test('every block type is edited once through its form, without JavaScript', async ({
  page,
  request,
}) => {
  test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
  const edit = await seededPage(request);
  await login(page, edit);
  const stamp = String(Date.now());
  const summaries = page.locator('details.block > summary');
  await expect(summaries).toHaveText([
    /^1\. Kop/,
    /^2\. Inschrijfformulier \(oud\)/,
    /^3\. Tekst/,
    /^4\. Betaalmuur/,
    /^5\. Afbeelding/,
    /^6\. Opening/,
    /^7\. Oproep/,
    /^8\. Kader/,
    /^9\. Vragen en antwoorden/,
    /^10\. Citaat/,
    /^11\. Video/,
    /^12\. Formulier/,
  ]);

  /** Fill one field of block `n`, save, and see the value back in the reopened form. */
  const edits: [number, string, string, string?][] = [
    [1, 'Tekst (nl)', `Kop ${stamp}`],
    [3, 'Tekst (nl)', `Nieuwe **tekst** met [een link](/over) ${stamp}`],
    [5, 'Beschrijving (alt-tekst) (nl)', `Een plein vol mensen ${stamp}`],
    [6, 'Titel (nl)', `Schone lucht ${stamp}`],
    [7, 'Titel (nl)', `Doe mee ${stamp}`],
    [8, 'Titel (nl)', `Let op ${stamp}`],
    [10, 'Naam', `Fatima ${stamp}`],
    [11, 'Titel (nl)', `Verslag ${stamp}`],
  ];
  for (const [n, label, value] of edits) {
    await (await block(page, n)).getByLabel(label, { exact: true }).fill(value);
    await save(page, n);
    await expect((await block(page, n)).getByLabel(label, { exact: true })).toHaveValue(value);
  }
  // A list row, a choice, and the two blocks without editable text: saved through their forms.
  await (
    await block(page, 9)
  )
    .getByLabel('Vraag (nl)', { exact: true })
    .first()
    .fill(`Wat? ${stamp}`);
  await save(page, 9);
  await expect(
    (await block(page, 9)).getByLabel('Vraag (nl)', { exact: true }).first()
  ).toHaveValue(`Wat? ${stamp}`);
  const width = (await block(page, 12)).getByLabel('Breedte');
  const next = (await width.inputValue()) === 'wide' ? 'Volle breedte' : 'Breed';
  await width.selectOption({ label: next });
  await save(page, 12);
  await expect((await block(page, 12)).getByLabel('Breedte')).toHaveValue(
    next === 'Breed' ? 'wide' : 'full'
  );
  for (const n of [2, 4]) await save(page, n);
  await expectNoAxeViolations(page);

  // The other locale of the rich text kept its item link, written as Markdown.
  await expect((await block(page, 3)).getByLabel('Tekst (en)', { exact: true })).toHaveValue(
    /^More about our work is in \[the annual report\]\(item:[0-9a-f-]{36}\)$/
  );
  // And the edited locale was read back from Markdown: the preview renders the bold and the link.
  const preview = await page.getByRole('link', { name: 'Voorbeeld (nl)' }).getAttribute('href');
  await page.goto(preview!);
  await expect(page.locator('main strong', { hasText: 'tekst' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'een link' })).toHaveAttribute('href', /\/over$/);
});

/** Make a page through the "new" form; returns its edit URL. */
async function newPage(page: Page, what: string): Promise<string> {
  const slug = `b-${what}-${test.info().project.name}-${Date.now()}`;
  await page.goto('/admin/probe/content/new?type=page');
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Titel (nl)').fill('Blokkenproef');
  await page.getByLabel('Titel (en)').fill('Block test');
  await page.getByRole('button', { name: 'Concept maken' }).click();
  await expect(page).toHaveURL(/\/admin\/probe\/content\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

/** Insert a block of `type` through the document's or block `n`'s insert form. */
async function insert(page: Page, type: string, place: string, n?: number) {
  const form = n
    ? (await block(page, n)).locator('form.insert')
    : page.locator('section > form.insert');
  await form.getByLabel('Soort').selectOption({ label: type });
  await form.getByLabel('Waar').selectOption({ label: place });
  await form.getByRole('button', { name: 'Velden invullen' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Nieuw blok: ${type}`);
}

test('a block is inserted, moved and removed, each through a form of its own', async ({ page }) => {
  await login(page, '/admin/probe');
  const edit = await newPage(page, 'ops');
  await expect(page.getByText('Dit item heeft nog geen blokken.')).toBeVisible();

  await insert(page, 'Kop', 'Onderaan');
  await expectNoAxeViolations(page);
  // Nothing typed: core refuses, the issue links to its field.
  await page.getByRole('button', { name: 'Blok invoegen' }).click();
  const summary = page.getByRole('alert');
  await expect(summary).toContainText('Het blok kon niet worden opgeslagen');
  await expect(summary.getByRole('link', { name: 'Tekst' })).toBeVisible();
  await page.getByLabel('Tekst (nl)').fill('Eerste kop');
  await page.getByLabel('Tekst (en)').fill('First heading');
  await page.getByRole('button', { name: 'Blok invoegen' }).click();
  await expect(page).toHaveURL(/\?done=blockInserted&block=/);
  await expect(page.getByRole('status')).toContainText('Blok ingevoegd.');

  await insert(page, 'Tekst', 'Voor dit blok', 1);
  await page.getByLabel('Tekst (nl)').fill('Een [open link](https://example.org');
  await page.getByRole('button', { name: 'Blok invoegen' }).click();
  await expect(page.getByRole('alert')).toContainText('een link is niet afgesloten met )');
  await expect(page.getByLabel('Tekst (nl)')).toHaveValue('Een [open link](https://example.org');
  await page.getByLabel('Tekst (nl)').fill('Een _schuine_ inleiding.');
  await page.getByLabel('Tekst (en)').fill('An _italic_ introduction.');
  await page.getByRole('button', { name: 'Blok invoegen' }).click();
  await expect(page.getByRole('status')).toContainText('Blok ingevoegd.');
  const summaries = page.locator('details.block > summary');
  await expect(summaries).toHaveText([
    /^1\. Tekst: Een schuine inleiding\./,
    /^2\. Kop: Eerste kop/,
  ]);

  await (await block(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
  await expect(page.getByRole('status')).toContainText('Blok verplaatst.');
  await expect(summaries).toHaveText([/^1\. Kop/, /^2\. Tekst/]);
  await expectNoAxeViolations(page);

  await (await block(page, 1)).getByRole('link', { name: 'Blok verwijderen' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Blok verwijderen?');
  await expect(page.locator('main')).toContainText('1. Kop: Eerste kop');
  await expectNoAxeViolations(page);
  await page.getByRole('button', { name: 'Ja, verwijder dit blok' }).click();
  await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockRemoved`));
  await expect(page.getByRole('status')).toContainText('Blok verwijderd.');
  await expect(summaries).toHaveText([/^1\. Tekst/]);
});

test('a block save on an outdated revision is a conflict that keeps what was typed', async ({
  page,
}) => {
  await login(page, '/admin/probe');
  const edit = await newPage(page, 'conflict');
  await insert(page, 'Kop', 'Onderaan');
  await page.getByLabel('Tekst (nl)').fill('Kop');
  await page.getByRole('button', { name: 'Blok invoegen' }).click();
  await expect(page.getByRole('status')).toContainText('Blok ingevoegd.');

  // Another tab saves the document in between.
  const other = await page.context().newPage();
  await other.goto(edit);
  await other.getByLabel('Titel (nl)', { exact: true }).fill('Tussendoor');
  await other.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await expect(other).toHaveURL(`${edit}?saved`);

  await (await block(page, 1)).getByLabel('Tekst (nl)', { exact: true }).fill('Mijn kop');
  await (await block(page, 1)).getByRole('button', { name: 'Blok opslaan' }).click();
  await expect(page.getByRole('alert')).toContainText('opgeslagen');
  await expect((await block(page, 1)).getByLabel('Tekst (nl)', { exact: true })).toHaveValue(
    'Mijn kop'
  );
  // Saving again is a deliberate choice on top of the newest revision.
  await save(page, 1);
  await expect((await block(page, 1)).getByLabel('Tekst (nl)', { exact: true })).toHaveValue(
    'Mijn kop'
  );
  await expect(page.getByLabel('Titel (nl)', { exact: true })).toHaveValue('Tussendoor');
});

test.describe('UI gate: the block forms at 320 CSS px and 200% text', () => {
  test.use({ viewport: { width: 320, height: 900 } });

  for (const text of ['100%', '200%'])
    test(`every action whole and no horizontal scroll, text ${text}`, async ({ page, request }) => {
      test.skip(test.info().project.name !== 'a11y', 'measures the layout with a script');
      const edit = await seededPage(request);
      await login(page, edit);
      const remove = await page
        .locator('details.block')
        .nth(6)
        .locator('a', { hasText: 'Blok verwijderen' })
        .getAttribute('href');
      for (const path of [edit, remove!]) {
        await page.goto(path);
        await page.evaluate(() =>
          document.querySelectorAll('details').forEach((d) => (d.open = true))
        );
        if (text !== '100%')
          await page.evaluate((size) => (document.documentElement.style.fontSize = size), text);
        if (path === edit)
          await page
            .locator('details.block')
            .nth(6)
            .screenshot({
              path: test.info().outputPath(`content-block-320-${text.replace('%', '')}.png`),
            });
        expect(await page.evaluate(layoutProblems), path).toEqual([]);
      }
      // The insert page of the block with the most fields.
      await page.goto(edit);
      await insert(page, 'Opening', 'Na dit blok', 7);
      if (text !== '100%')
        await page.evaluate((size) => (document.documentElement.style.fontSize = size), text);
      expect(await page.evaluate(layoutProblems), 'new hero').toEqual([]);
    });
});

/** The checks of the content admin gate (content-admin.spec.ts), over every action on the page. */
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
  for (const l of document.querySelectorAll('.card label, .card legend, .card summary')) {
    const card = l.closest('.card')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(l);
    if (range.getBoundingClientRect().right > card.right + 1)
      out.push(`past its card: ${l.textContent?.trim()}`);
  }
  return out;
}
