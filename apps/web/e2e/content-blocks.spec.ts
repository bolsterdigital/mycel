// flow: publish
// An operator builds a page from blocks: every block form, inserting and moving, and the block
// cards of the edit screen.

import { BLOCK_TYPES, UseCaseError, systemPrincipal, useCases } from '@mycel/core';
import { conditionalProbeForm } from '@mycel/core/testing';
import { type APIRequestContext, type Locator, type Page, expect } from '@playwright/test';
import { test } from './lib/evidence/page';
import { expectNoAxeViolations } from './lib/axe';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, TEXT_SIZES, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';
import { isA11y, onlyA11y } from './lib/project';
import { callApi, pictureAtBothEnds, requireApi, seededPage } from './lib/api';
import { expectPixels } from './lib/images';
import { settingsEvidence } from './lib/evidence/settings';
import { openPublication } from './lib/publication';
import {
  block,
  blockPage,
  card,
  editorReady,
  linkTo,
  more,
  reloadsEditor,
  save,
} from './lib/editor';

// Keep the unfinished locale-edit action on timeout without tracing every content flow.
// Rejected: a guessed readiness wait, which would change the timing being investigated.
const localeEvidenceTest = test.extend({ trace: ['retain-on-failure', { scope: 'worker' }] });

// Block forms of the content admin (brief content-editor § B): every block type is edited once
// through its generated form, and a block is inserted, moved and removed, all with native forms.
// The `no-js` project is the no-JavaScript proof and the `a11y` project runs axe and the UI gate
// (skill ui-action-layout). Each project edits its own seeded page (`e2e-blokken-<project>`,
// scripts/e2e/e2e.mjs) with the first example of every type, so the bulk fixture is seeded once and
// not made here (admin.spec.ts reads its audit log).
test.describe('content-blocks', () => {
  test.use({ locale: 'nl-NL' });

  test('every block type is edited once through its form, without JavaScript', async ({
    page,
    request,
  }) => {
    requireApi();
    const edit = await seededPage(request);
    await login(page, edit);
    const stamp = String(Date.now());
    const titles = page.locator('.ui-block-card-title');
    await expect(titles).toHaveCount(BLOCK_TYPES.length);
    const placed = [
      'Blok 01 Kop',
      'Blok 02 Inschrijfformulier (oud)',
      'Blok 03 Tekst',
      'Blok 04 Betaalmuur',
      'Blok 05 Afbeelding',
      'Blok 06 Opening',
      'Blok 07 Oproep',
      'Blok 08 Kader',
      'Blok 09 Vragen en antwoorden',
      'Blok 10 Citaat',
      'Blok 11 Video',
      'Blok 12 Formulier',
    ];
    for (const [i, title] of placed.entries()) await expect(titles.nth(i)).toHaveText(title);

    /** One field of each block, a list row and a choice, saved at once (one form, one save). */
    const edits: [number, string, string][] = [
      [1, 'Tekst', `Kop ${stamp}`],
      [3, 'Tekst', `Nieuwe **tekst** met [een link](/over) ${stamp}`],
      [5, 'Beschrijving in het Nederlands', `Een plein vol mensen ${stamp}`],
      [6, 'Titel', `Schone lucht ${stamp}`],
      [7, 'Titel', `Doe mee ${stamp}`],
      [8, 'Titel', `Let op ${stamp}`],
      [10, 'Naam', `Fatima ${stamp}`],
      [11, 'Titel', `Verslag ${stamp}`],
      [9, 'Vraag', `Wat? ${stamp}`],
    ];
    // The first field of that name: a hero also has the title of its image's work, in the
    // credit fieldset further down.
    for (const [n, label, value] of edits) {
      const current = await block(page, n);
      if (n === 3 && isA11y()) {
        const surface = current.locator('.writing-surface .ProseMirror');
        await surface.locator('p').first().fill('');
        await surface.evaluate((element, source) => {
          const clipboardData = new DataTransfer();
          clipboardData.setData('text/plain', source);
          element.dispatchEvent(
            new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
          );
        }, value);
      } else await current.getByLabel(label, { exact: true }).first().fill(value);
    }
    const width = (await block(page, 12)).getByLabel('Breedte');
    const next = (await width.inputValue()) === 'wide' ? 'Volle breedte' : 'Breed';
    await width.selectOption({ label: next });
    await (await block(page, 9)).getByLabel('Breedte').selectOption('wide');
    // A reference-only grid edits a choice; other added types edit their first text field.
    const first = (at: Locator) => at.locator('input[type="text"]').first();
    const gridColumns = (at: Locator) => at.locator('select[name$=".columns"]');
    for (let n = 13; n <= BLOCK_TYPES.length; n++) {
      const at = await block(page, n);
      if (await gridColumns(at).count()) await gridColumns(at).selectOption('4');
      else await first(at).fill(`Blok ${n} ${stamp}`);
    }
    await save(page, 1);
    // Each value back in the reopened form; the old signup form and the paywall have no field
    // to change, and the save keeps them through the document alone.
    for (const [n, label, value] of edits)
      await expect((await block(page, n)).getByLabel(label, { exact: true }).first()).toHaveValue(
        value
      );
    for (let n = 13; n <= BLOCK_TYPES.length; n++) {
      const at = await block(page, n);
      if (await gridColumns(at).count()) await expect(gridColumns(at)).toHaveValue('4');
      else await expect(first(at)).toHaveValue(`Blok ${n} ${stamp}`);
    }
    await expect(card(page, 2).locator('.ui-block-card-title')).toHaveText(
      'Blok 02 Inschrijfformulier (oud)'
    );
    await expect(card(page, 4).locator('.ui-block-card-title')).toHaveText('Blok 04 Betaalmuur');
    await expect((await block(page, 12)).getByLabel('Breedte')).toHaveValue(
      next === 'Breed' ? 'wide' : 'full'
    );
    // Stored, not only posted back: a fresh load shows the choice.
    await page.reload();
    await editorReady(page);
    await expect((await block(page, 9)).getByLabel('Breedte')).toHaveValue('wide');
    await expectNoAxeViolations(page);

    // The other locale, shown on its own (#66 PR 4), kept its values: the FAQ's questions, and
    // the rich text its item link, written as Markdown.
    await page.goto(`${edit}?locale=en`);
    await expect((await block(page, 9)).getByLabel('Vraag', { exact: true }).first()).toHaveValue(
      /.+/
    );
    await expect((await block(page, 3)).getByLabel('Tekst', { exact: true })).toHaveValue(
      /^More about our work is in \[the annual report\]\(item:[0-9a-f-]{36}\)$/
    );
    await page.goto(edit);
    // And the edited locale was read back from Markdown: the preview renders the bold and the link.
    const preview = await page.locator('a[data-preview-link="nl"]').getAttribute('href');
    await page.goto(preview!);
    await expect(page.locator('main strong', { hasText: 'tekst' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'een link' })).toHaveAttribute('href', /\/over$/);
    await expect(page.locator('main .faq.width-wide')).toContainText(`Wat? ${stamp}`);
    await page.goto(edit);
    if (isA11y()) {
      await editorReady(page);
      await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
      await expect(
        page.frameLocator('iframe[data-live-preview-frame]').locator('.faq.width-wide')
      ).toBeVisible();
      // Closed again, the side column with the publish button comes back.
      await page.getByRole('button', { name: 'Voorbeeld', exact: true }).click();
    }
    await openPublication(page);
    await page.getByRole('button', { name: /^(Wijzigingen )?publiceren$/i }).click();
    await page.goto(`/probe/e2e-blokken-${test.info().project.name}`);
    await expect(page.locator('main .faq.width-wide')).toContainText(`Wat? ${stamp}`);
  });

  /**
   * Choose a block of `type` at the end, or before or after block `n`: it shows empty at its
   * place in the same form (#66 PR 2) and is stored with the next save. Returns that card.
   */
  async function insert(page: Page, type: string, place: 'end' | 'before' | 'after', n?: number) {
    // The "+" above each card (#66 PR 3); after the last card that is the one at the end.
    const above = n && (place === 'before' ? n : n + 1);
    const folds = page.locator('details.ui-block-insert');
    // With scripts, wait until they have moved the choices: the tabs shrink the page and the search
    // field pushes the buttons down 59 px, so an earlier click lands beside them and is lost (#167).
    await editorReady(page);
    if (above && above <= (await folds.count())) {
      const fold = folds.nth(above - 1);
      await fold.locator('summary').click();
      await fold.getByRole('button', { name: type, exact: true }).click();
    } else {
      await page
        .locator('[data-block-picker]')
        .last()
        .getByRole('button', { name: type, exact: true })
        .click();
    }
    const fresh = page.locator('#block-new');
    await expect(fresh.getByRole('heading')).toHaveText(`Nieuw blok: ${type}`);
    // With the script, its landing moves focus into the new block once it is ready; a fill
    // before that loses its first characters to the focus change (a verify flake, 2026-10-31).
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    return fresh;
  }

  /** Store the chosen block with everything else in the form. */
  async function add(page: Page) {
    await reloadsEditor(page, () =>
      page.getByRole('button', { name: 'Toevoegen en opslaan' }).click()
    );
  }

  test('a block is inserted, moved and removed in place, without losing what was typed', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'ops');
    await expect(page.getByText('Dit item heeft nog geen blokken.')).toBeVisible();

    // Another choice replaces an empty new block; typed words stay.
    await insert(page, 'Fotogalerij', 'end');
    let fresh = await insert(page, 'Actierij', 'end');
    const words = fresh.locator('#b-new-p-cards-0-title-nl');
    await words.fill('Doneer');
    await page.getByRole('button', { name: 'Kop', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Kaarten' })).toBeVisible();
    await expect(words).toHaveValue('Doneer');
    await fresh.getByRole('button', { name: 'Annuleren' }).click();
    fresh = await insert(page, 'Kop', 'end');
    await expect(page).toHaveURL(new RegExp(`${edit}\\?insert=heading&place=end#block-new$`));
    await expectNoAxeViolations(page);
    // Nothing typed: core refuses, the issue links to its field, the block stays at its place.
    await add(page);
    const summary = page.getByRole('alert');
    await expect(summary).toContainText('Het blok kon niet worden opgeslagen');
    await expect(summary.getByRole('link', { name: 'Tekst' })).toBeVisible();
    fresh = page.locator('#block-new');
    await fresh.getByLabel('Tekst', { exact: true }).fill('Eerste kop');
    await add(page);
    await expect(page).toHaveURL(/\?saved&block=/);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');

    fresh = await insert(page, 'Tekst', 'before', 1);
    await fresh.getByLabel('Tekst', { exact: true }).fill('Een [open link](https://example.org');
    await add(page);
    await expect(page.getByRole('alert')).toContainText('een link is niet afgesloten met )');
    fresh = page.locator('#block-new');
    await expect(fresh.getByLabel('Tekst', { exact: true })).toHaveValue(
      'Een [open link](https://example.org'
    );
    await fresh.getByLabel('Tekst', { exact: true }).fill('Een _schuine_ inleiding.');
    await add(page);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const summaries = page.locator('.ui-block-card-title');
    await expect(summaries).toHaveText(['Blok 01 Tekst', 'Blok 02 Kop']);
    // At rest each card shows what it says, beside a named Edit (MY-110 A).
    await expect(page.locator('[data-block-rest]')).toHaveText([
      'Een schuine inleiding.',
      'Eerste kop',
    ]);
    for (const fold of await page.locator('details.block').all())
      await expect(fold.locator(':scope > summary')).toHaveAccessibleName(
        (await fold.getAttribute('open')) === null ? 'Bewerken' : 'Gereed'
      );

    // A block action saves what was typed elsewhere first (brief edit-screen § 1 point 4).
    await page.locator('#title\\.nl').fill('Blokkenproef bewaard');
    await (await more(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.getByRole('status')).toContainText('Blok verplaatst.');
    await expect(summaries).toHaveText(['Blok 01 Kop', 'Blok 02 Tekst']);
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef bewaard');
    await expectNoAxeViolations(page);

    // A chosen block that is not wanted after all: the rest of the form is still saved.
    fresh = await insert(page, 'Citaat', 'end');
    await page.locator('#title\\.nl').fill('Blokkenproef zonder citaat');
    await fresh.getByRole('button', { name: 'Annuleren' }).click();
    await expect(page.locator('#block-new')).toHaveCount(0);
    await expect(summaries).toHaveCount(2);
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef zonder citaat');

    // Remove asks nothing: the notice after it offers Undo, which puts the block back in place.
    await (await more(page, 1)).getByRole('button', { name: 'Verwijderen' }).click();
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockRemoved`));
    const status = page.getByRole('status');
    await expect(status).toContainText('Blok verwijderd.');
    await expect(summaries).toHaveText(['Blok 01 Tekst']);
    await expectNoAxeViolations(page);
    await page.locator('#title\\.nl').fill('Blokkenproef na ongedaan maken');
    await status.getByRole('button', { name: 'Ongedaan maken' }).click();
    await expect(page.getByRole('status')).toContainText('Blok teruggezet.');
    await expect(summaries).toHaveText(['Blok 01 Kop', 'Blok 02 Tekst']);
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef na ongedaan maken');
    await expect(page.getByRole('button', { name: 'Ongedaan maken' })).toHaveCount(0);
  });

  // #66 PR 6c: with JavaScript the block type list has a search field (Enter adds the first
  // match), `?` opens the shortcuts panel and the bar stays in view; the undo notice and the
  // search keep whole labels at 320 px and 200% text (skill ui-action-layout).
  test('the block type search, the shortcuts panel and the bar that stays in view', async ({
    page,
  }) => {
    onlyA11y('the search, the panel and the keys are the screen script');
    await login(page, '/admin/probe');
    await blockPage(page, 'search');
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const search = page.getByLabel('Zoek een bloktype');
    await search.fill('cita');
    await expect(page.locator('[data-block-type]:visible')).toHaveText(['Citaat']);
    // Typing in the search is not a change of the document.
    await expect(page.locator('[data-save-state]')).not.toHaveAttribute('data-current', 'unsaved');
    await search.fill('zzz');
    await expect(page.locator('[data-block-type]:visible')).toHaveCount(0);
    await expect(page.locator('[data-type-count]')).toHaveText('Geen bloktype gevonden');
    const noMatchUrl = page.url();
    await search.press('Enter');
    await expect(page).toHaveURL(noMatchUrl);
    await expect(search).toBeFocused();
    await expect(page.locator('#block-new')).toHaveCount(0);
    await search.fill('kop');
    await search.press('Enter');
    await expect(page.locator('#block-new').getByRole('heading')).toHaveText('Nieuw blok: Kop');
    await page.locator('#block-new').getByLabel('Tekst', { exact: true }).fill('Gevonden');
    await add(page);
    await expect(page.locator('[data-block-rest]')).toHaveText(['Gevonden']);

    // `?` outside a text field opens the shortcuts; Escape closes them again.
    await page.locator('#blocks').click();
    await page.keyboard.press('?');
    const keys = page.locator('details[data-shortcuts]');
    await expect(keys).toHaveAttribute('open', '');
    await expect(keys).toContainText('Opslaan');
    await page.keyboard.press('Escape');
    await expect(keys).not.toHaveAttribute('open', '');
    await page.locator('#title\\.nl').press('?');
    await expect(keys).not.toHaveAttribute('open', '');
    await page.locator('#title\\.nl').fill('Blokkenproef');

    // On a wide screen the bar stays at the top while the page scrolls.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.mouse.wheel(0, 2000);
    await expect
      .poll(() => page.locator('.ui-item-bar').evaluate((e) => e.getBoundingClientRect().top))
      .toBeLessThan(2);
    await expectNoAxeViolations(page);

    // Remove, then the notice with Undo and the search, narrow and at 200% text.
    await (await more(page, 1)).getByRole('button', { name: 'Verwijderen' }).click();
    await expect(page.getByRole('button', { name: 'Ongedaan maken' })).toBeVisible();
    await page.setViewportSize(NARROW);
    for (const text of TEXT_SIZES) {
      await setTextSize(page, text);
      await layoutGate(page, `undo notice and type search at ${text}`);
    }
  });

  test('a block is duplicated right after itself, with its fields and a new id', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'dup');
    const fresh = await insert(page, 'Kop', 'end');
    await fresh.getByLabel('Tekst', { exact: true }).fill('Twee keer');
    await add(page);
    const original = await page.locator('details.block').first().getAttribute('id');
    // What was typed elsewhere is saved first, as with every block action.
    await page.locator('#title\\.nl').fill('Blokkenproef gedupliceerd');
    await (await more(page, 1)).getByRole('button', { name: 'Dupliceren' }).click();
    await expect(page.getByRole('status')).toContainText('Blok gedupliceerd.');
    await expect(page.locator('#title\\.nl')).toHaveValue('Blokkenproef gedupliceerd');
    await expect(page.locator('.ui-block-card-title')).toHaveText(['Blok 01 Kop', 'Blok 02 Kop']);
    const copy = page.locator('details.block').nth(1);
    await expect(copy).not.toHaveAttribute('id', original!);
    // The screen lands on the copy at rest (it is complete), with the same fields.
    await expect(page).toHaveURL(new RegExp(`${edit}\\?done=blockDuplicated#block-`));
    await expect(copy).not.toHaveAttribute('open', '');
    await expect((await block(page, 2)).getByLabel('Tekst', { exact: true })).toHaveValue(
      'Twee keer'
    );
    // A text block cannot stand next to its copy: it offers no duplicate.
    await insert(page, 'Tekst', 'end');
    await page.locator('#block-new').getByLabel('Tekst', { exact: true }).fill('Los');
    await add(page);
    await expect(card(page, 3).getByRole('button', { name: 'Dupliceren' })).toHaveCount(0);
    await expectNoAxeViolations(page);
  });

  test('FAQ v2 inserts, moves and publishes through native forms in both locales', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'faq-width');
    let fresh = await insert(page, 'Kop', 'end');
    await fresh.getByLabel('Tekst', { exact: true }).fill('Vooraf');
    await add(page);
    fresh = await insert(page, 'Vragen en antwoorden', 'after', 1);
    await fresh.getByLabel('Variant').selectOption('accordion');
    await fresh.getByLabel('Breedte').selectOption('full');
    await fresh.getByLabel('Vraag').first().fill('Waarom is dit belangrijk?');
    await fresh.getByLabel('Antwoord').first().fill('Omdat iedereen kan meedoen.');
    await add(page);
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const id = await page.locator('details.block').nth(1).getAttribute('id');
    await (await more(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page.locator('details.block').first()).toHaveAttribute('id', id!);
    await page.reload();
    await expect((await block(page, 1)).getByLabel('Breedte')).toHaveValue('full');
    // English on its own screen (#66 PR 4): the same blocks, their English fields.
    await page.goto(`${edit}?locale=en`);
    await (await block(page, 1)).getByLabel('Vraag').first().fill('Why does this matter?');
    await (
      await block(page, 1)
    )
      .getByLabel('Antwoord')
      .first()
      .fill('Because everyone can take part.');
    await (await block(page, 2)).getByLabel('Tekst', { exact: true }).fill('Before');
    await save(page, 2);
    await expect((await block(page, 1)).getByLabel('Vraag').first()).toHaveValue(
      'Why does this matter?'
    );
    for (const locale of ['nl', 'en']) {
      await page.goto(`${edit}?locale=${locale}`);
      const preview = await page.locator(`a[data-preview-link="${locale}"]`).getAttribute('href');
      await page.goto(preview!);
      await expect(page.locator('main .faq-accordion.width-full')).toContainText(
        locale === 'nl' ? 'Waarom is dit belangrijk?' : 'Why does this matter?'
      );
      await page.goto(`${edit}?locale=${locale}`);
      await openPublication(page);
      await page.getByRole('button', { name: 'Publiceren', exact: true }).click();
      await expect(page.getByRole('status')).toContainText(`Gepubliceerd in ${locale}.`);
    }
    await expectNoAxeViolations(page);
  });

  test('the integrated article keeps its structured card, identity and other locale in one save', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const source = await callApi(request, 'content.item.list', {
      type: 'article',
      slug: 'quality-article-v3',
    });
    const fetched = await callApi(request, 'content.item.get', { itemId: source.items[0].id });
    const prose = fetched.revision.document.blocks.find(
      (b: { type: string }) => b.type === 'rich-text'
    );
    const faqSource = await callApi(request, 'content.item.list', {
      type: 'page',
      slug: 'e2e-blokken-a11y',
    });
    const fixture = await callApi(request, 'content.item.get', { itemId: faqSource.items[0].id });
    const faq = fixture.revision.document.blocks.find((b: { type: string }) => b.type === 'faq');
    const created = await callApi(request, 'content.item.create', {
      slug: `integrated-${Date.now()}`,
      document: { ...fetched.revision.document, blocks: [prose, faq] },
    });
    const edit = `/admin/probe/content/${created.item.id}`;
    await login(page, edit);
    const surface = page.locator('.writing-surface .ProseMirror').first();
    await expect(surface).toBeVisible();
    await surface.locator('.editor-prose p').first().fill('Artikeltekst in één scherm');
    await page.locator('#title\\.nl').fill('Een nieuwe kop');
    const card = surface.locator('details.block');
    await card.locator(':scope > summary').click();
    await card.locator('details.ui-block-group > summary').click();
    await card.getByLabel('Breedte').selectOption('full');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const saved = await callApi(request, 'content.item.get', { itemId: created.item.id });
    expect(saved.revision.document.title.nl).toBe('Een nieuwe kop');
    expect(saved.revision.document.blocks.map((b: { id: string }) => b.id)).toEqual([
      prose.id,
      faq.id,
    ]);
    expect(saved.revision.document.blocks[0].props.content.en).toEqual(prose.props.content.en);
    expect(saved.revision.document.blocks[1].props.width).toBe('full');
    await expectNoAxeViolations(page);
  });

  test('Enter and native insertion keep a direct content locale through refusal and legacy posts', async ({
    page,
    request,
  }) => {
    // The bar's locale switch comes before Save in the document; without a script Enter would
    // post the first submit button, "nl", and switch away (#66 PR 6). Both projects.
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'enter');
    await page.goto(`${edit}?locale=en`);
    // With the script, type only once edit-screen.js has started, or it misses the input.
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await page.locator('#title\\.en').fill('Saved with Enter');
    await page.locator('#title\\.en').press('Enter');
    await expect(page).toHaveURL(`${edit}?saved&locale=en`);
    await expect(page.locator('#title\\.en')).toHaveValue('Saved with Enter');
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === 'mycel-content-locale')
    ).toBe(false);

    // A direct English URL has no locale cookie. The new chooser carries that locale even
    // when saving an incomplete pending block refuses the next choice. Other form actions
    // retain their existing contract; this is not a general refused-save locale repair.
    const atEnd = () => page.locator('[data-block-picker]').last();
    await expect(atEnd().getByRole('button', { name: 'Kop', exact: true })).toHaveAttribute(
      'formaction',
      '?/insert&locale=en'
    );
    await atEnd().getByRole('button', { name: 'Kop', exact: true }).click();
    const fresh = page.locator('#block-new');
    await fresh.locator('[name="new.p.text.en"]').fill('x'.repeat(201));
    await atEnd().getByRole('button', { name: 'Citaat', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('[name="editLocale"]')).toHaveValue('en');
    await expect(page.locator('#title\\.en')).toHaveValue('Saved with Enter');
    await fresh.locator('[name="new.p.text.en"]').fill('An English heading');
    await add(page);

    // Existing native posts with insertType still select the same pending type.
    const legacy = atEnd().getByRole('button', { name: 'Kop', exact: true });
    await legacy.evaluate((button) => {
      (button as HTMLButtonElement).value = 'end';
      const field = document.createElement('input');
      field.type = 'hidden';
      field.name = 'insertType.end';
      field.value = 'quote';
      button.closest('form')!.append(field);
    });
    await legacy.click();
    await expect(fresh.getByRole('heading')).toHaveText('Nieuw blok: Citaat');
    await fresh.getByRole('button', { name: 'Annuleren' }).click();

    // A forged type stays outside the existing pending validator and is explained in place.
    const unknown = atEnd().getByRole('button', { name: 'Kop', exact: true });
    await unknown.evaluate(
      (button) => ((button as HTMLButtonElement).value = 'not-registered|end')
    );
    await unknown.click();
    await expect(
      page.getByText('Dit bloktype of invoegpunt is niet meer beschikbaar. Kies een ander blok.')
    ).toBeVisible();
    await expect(fresh).toHaveCount(0);
    const { revision } = await callApi<{
      revision: {
        document: {
          title: { nl: string; en: string };
          blocks: { props: { text: { en: string } } }[];
        };
      };
    }>(request, 'content.item.get', { itemId: edit.split('/').at(-1)! });
    expect(revision.document.title).toEqual({ nl: 'Blokkenproef', en: 'Saved with Enter' });
    expect(revision.document.blocks).toHaveLength(1);
    expect(revision.document.blocks[0]!.props.text.en).toBe('An English heading');
  });

  test('the screen says what is unsaved, saves with Ctrl+S and warns before leaving', async ({
    page,
  }) => {
    onlyA11y('the save state, the shortcut and the leave warning are the script');
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'keys');
    const state = page.locator('[data-save-state]');
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await expect(state).toHaveAttribute('data-current', 'none');
    await page.locator('#title\\.nl').fill('Nog niet bewaard');
    await expect(state).toHaveAttribute('data-current', 'unsaved');
    await expect(state.locator('[data-save-live]')).toHaveText('Niet opgeslagen wijzigingen');
    // Leaving asks first; staying keeps what was typed.
    let asked = false;
    page.once('dialog', (dialog) => {
      asked = dialog.type() === 'beforeunload';
      void dialog.dismiss();
    });
    await page.locator('.ui-item-bar-back').click();
    await expect.poll(() => asked).toBe(true);
    await expect(page).toHaveURL(edit);
    await expect(page.locator('#title\\.nl')).toHaveValue('Nog niet bewaard');
    await page.locator('#title\\.nl').press('ControlOrMeta+s');
    await expect(page).toHaveURL(`${edit}?saved`);
    await expect(page.locator('#title\\.nl')).toHaveValue('Nog niet bewaard');
    await expect(state).toHaveAttribute('data-current', 'done');
    await expect(state.locator('[data-save-live]')).toHaveText('Alles opgeslagen');
    // Choosing a block type to insert is no change to the document: leaving does not ask.
    await page
      .locator('[data-block-picker]')
      .last()
      .getByRole('button', { name: 'Kop', exact: true })
      .focus();
    await expect(state).toHaveAttribute('data-current', 'done');
  });

  // The router must not carry a click from the editor to another admin page: that page ships no
  // client code by design, and the editor's scripts run once per document, so coming back left a
  // screen that no longer knew it had changes (#145). Back and by link, as both are common.
  test('leaving for Revisions warns about unsaved changes, and coming back the scripts still run', async ({
    page,
    request,
  }) => {
    onlyA11y('the save state, the leave warning and the search are the scripts');
    requireApi();
    const run = `a1-return-${Date.now()}`;
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: run,
      document: {
        type: 'article',
        title: { nl: 'Heen en terug' },
        defaultLocale: 'nl',
        locales: ['nl'],
        blocks: [],
        authorIds: [],
      },
    });
    const edit = `/admin/probe/content/${item.id}`;
    await login(page, edit);
    const state = page.locator('[data-save-state]');
    const revisions = page.locator(`a[href$="${edit}/revisions"]`);
    const stillWorks = async () => {
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      await expect(
        page.locator('#authors').getByRole('searchbox', { name: 'Zoeken' })
      ).toBeVisible();
      await expect(state).not.toHaveAttribute('data-current', 'unsaved');
      await page.locator('#title\\.nl').fill(`Gewijzigd ${Date.now()}`);
      await expect(state).toHaveAttribute('data-current', 'unsaved');
    };

    // Unsaved: the link asks first, and staying keeps what was typed.
    await stillWorks();
    const typed = await page.locator('#title\\.nl').inputValue();
    let asked = false;
    page.once('dialog', (dialog) => {
      asked = dialog.type() === 'beforeunload';
      void dialog.dismiss();
    });
    await revisions.click();
    await expect.poll(() => asked).toBe(true);
    await expect(page.locator('#title\\.nl')).toHaveValue(typed);
    await page.locator('#title\\.nl').press('ControlOrMeta+s');
    await expect(page).toHaveURL(new RegExp(`${edit}\\?saved$`));

    // Nothing unsaved: there and back with the browser, then there and back by link.
    await revisions.click();
    await expect(page).toHaveURL(new RegExp(`${edit}/revisions$`));
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${edit}\\?saved$`));
    await stillWorks();
    await page.locator('#title\\.nl').press('ControlOrMeta+s');
    await expect(state).toHaveAttribute('data-current', 'done');
    await revisions.click();
    await expect(page).toHaveURL(new RegExp(`${edit}/revisions$`));
    await page.locator(`a[href$="${edit}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${edit}$`));
    await stillWorks();
  });

  /** A new page with a heading, a text and a quote, reopened. */
  const textBlocksAtRest = async (page: Page) => {
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'text-rest');
    const heading = await insert(page, 'Kop', 'end');
    await heading.getByLabel('Tekst', { exact: true }).fill('Wie wij zijn');
    await add(page);
    const text = await insert(page, 'Tekst', 'end');
    await text
      .getByLabel('Tekst', { exact: true })
      .fill('## Tussenkop\n\nEen **vette** zin met [een link](https://example.org/weg).');
    await add(page);
    const quote = await insert(page, 'Citaat', 'end');
    await quote.getByLabel('Tekst', { exact: true }).fill('Zo is het.');
    await quote.getByLabel('Naam', { exact: true }).fill('Sam de Vries');
    await add(page);

    await page.goto(edit);
    await editorReady(page);
    return page.locator('[data-block-rest]');
  };

  // What each kind says at rest is checked without a browser, over `textRestOf`, `restWords` and
  // `BlockText`. What only a browser shows stays here, once, over the page with every block type.
  test('every block at rest is whole and inert, and asks nothing of a video host', async ({
    page,
    request,
  }) => {
    const { hosts, form } = await videoAndFormAtRest(page, request);
    const rests = page.locator('[data-block-rest]');
    // A link may only stay on this screen: anything else would leave the unsaved form.
    await expect(
      rests.locator(
        'h1, h2, h3, h4, h5, h6, [id], a[href]:not([href^="#"]), form, input, select, textarea, iframe'
      )
    ).toHaveCount(0);
    // Every text-like field in the shared corpus has a visible shape, without native controls.
    const expectedInputs = conditionalProbeForm('fixture').fields.filter(
      (field) => !['checkbox', 'consent', 'hidden'].includes(field.type)
    ).length;
    for (const shape of [form, card(page, 2).locator('[data-block-rest]')]) {
      const inputs = shape.locator('.ui-block-text-input');
      await expect(inputs).toHaveCount(expectedInputs);
      for (const input of await inputs.all()) await expect(input).toBeVisible();
    }
    // The seeded page is public: the boundary is there, and holds nobody back yet.
    await expect(card(page, 4).locator('.ui-block-text-boundary')).toContainText('openbaar');

    await page.setViewportSize(NARROW);
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size);
      await layoutGate(page, `every block at rest at ${size}`, '.item-blocks');
    }
    await setTextSize(page, '100%');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectNoAxeViolations(page);
    expect(hosts).toEqual([]);
  });

  test('a heading, a text and a quote say what was typed when they close', async ({ page }) => {
    onlyA11y();
    const rests = await textBlocksAtRest(page);
    // With the script: a click on the words goes straight into the field, the rest view steps
    // aside so the words stand there once, and closing shows what was typed, unsaved.
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const folds = page.locator('details.block');
    await rests.nth(0).click();
    const headingField = folds.nth(0).getByLabel('Tekst', { exact: true });
    await expect(headingField).toBeFocused();
    await expect(rests.nth(0).locator('.ui-block-text')).toBeHidden();
    await headingField.fill('Wie wij nu zijn');
    await folds.nth(0).locator('[data-block-done] button').click();
    await expect(rests.nth(0).locator('.ui-block-text-heading')).toHaveText('Wie wij nu zijn');

    await rests.nth(2).click();
    await folds.nth(2).getByLabel('Functie', { exact: true }).fill('Voorzitter');
    await page.keyboard.press('Escape');
    await expect(rests.nth(2).locator('footer')).toHaveText('Sam de Vries, Voorzitter');

    // Opened and closed unchanged, the text keeps what the server set; typed into, it follows.
    const editor = folds.nth(1).locator('.ProseMirror');
    await rests.nth(1).click();
    await expect(editor).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(folds.nth(1)).not.toHaveAttribute('open', '');
    await expect(folds.nth(1).locator(':scope > summary')).toBeFocused();
    await expect(rests.nth(1).locator('[data-heading]')).toHaveText('Tussenkop');
    await rests.nth(1).click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('Erbij. ');
    await page.keyboard.press('Escape');
    await expect(folds.nth(1)).not.toHaveAttribute('open', '');
    await expect(rests.nth(1)).toContainText('Erbij.');
    await expect(rests.nth(1).locator('strong')).toHaveText('vette');
    await expect(rests.nth(1).locator('a[href]')).toHaveCount(0);

    // All of it survives the save, marks and link included.
    await page.getByRole('button', { name: 'Opslaan' }).first().click();
    await expect(page.getByRole('status').first()).toContainText('Opgeslagen');
    await expect(rests.nth(0).locator('.ui-block-text-heading')).toHaveText('Wie wij nu zijn');
    await expect(rests.nth(1).locator('[data-link]')).toHaveText('een link');
    await expect(rests.nth(2).locator('footer')).toHaveText('Sam de Vries, Voorzitter');
  });

  /** A new page with a callout, an FAQ and a CTA, reopened. */
  const calloutFaqCtaAtRest = async (page: Page) => {
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'c2-rest');
    const callout = await insert(page, 'Kader', 'end');
    await callout.getByLabel('Titel', { exact: true }).fill('Let op');
    await callout.getByLabel('Tekst', { exact: true }).fill('Een **vette** zin.');
    await add(page);
    const faq = await insert(page, 'Vragen en antwoorden', 'end');
    await faq.getByLabel('Vraag', { exact: true }).first().fill('Waarom dit?');
    await faq.getByLabel('Antwoord', { exact: true }).first().fill('Omdat **het** kan.');
    await add(page);
    const cta = await insert(page, 'Oproep', 'end');
    await cta.getByLabel('Titel', { exact: true }).fill('Doe mee');
    await cta.getByLabel('Tekst op de knop', { exact: true }).first().fill('Teken nu');
    await linkTo(cta, 0, 'https://example.org/teken');
    await add(page);

    await page.goto(edit);
    const rests = page.locator('[data-block-rest]');
    const box = rests.nth(0).locator('.ui-block-text-callout');
    return { edit, rests, box };
  };

  test('a callout, an FAQ and a CTA open at the words clicked, and show what changed', async ({
    page,
  }) => {
    onlyA11y();
    const { edit, rests, box } = await calloutFaqCtaAtRest(page);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    // The second place is there for a label typed later, and takes no room until then.
    await expect(rests.nth(2).locator('.ui-block-text-action').nth(1)).toBeHidden();
    const folds = page.locator('details.block');
    const done = (i: number) => folds.nth(i).locator('[data-block-done] button').click();

    // A click lands in the field those words came from; closing shows what changed, kind included.
    await box.locator('.ui-block-text-prose').click();
    await expect(folds.nth(0).locator('.ProseMirror')).toBeFocused();
    await page.keyboard.type('Erbij. ');
    await folds.nth(0).locator('details.ui-block-group > summary').click();
    await folds.nth(0).getByLabel('Variant').selectOption({ label: 'Waarschuwing' });
    await folds.nth(0).getByLabel('Titel', { exact: true }).fill('');
    await done(0);
    await expect(box).toHaveAttribute('data-variant', 'warning');
    await expect(box.locator('.ui-block-text-kind')).toHaveText('Waarschuwing');
    await expect(box).toContainText('Erbij.');
    await expect(box.locator('strong')).toHaveText('vette');
    // An emptied optional title goes, as the save will make it.
    await expect(box.locator('.ui-block-text-title')).toBeHidden();

    // A CTA's preview goes nowhere: a click on its button opens the block at that label.
    await rests.nth(2).locator('.ui-block-text-action').first().click();
    await expect(page).toHaveURL(new RegExp(`${edit}$`));
    const label = folds.nth(2).getByLabel('Tekst op de knop', { exact: true });
    await expect(label.first()).toBeFocused();
    await label.nth(1).fill('Lees meer');
    const second = folds.nth(2);
    await linkTo(second, 1, 'https://example.org/meer');
    await label.nth(1).focus();
    await page.keyboard.press('Escape');
    await expect(rests.nth(2).locator('.ui-block-text-action').nth(1)).toHaveText('Lees meer');

    // An FAQ's answer goes to its editor; its question to its field.
    await rests.nth(1).locator('.ui-block-text-prose').first().click();
    await expect(folds.nth(1).locator('.ProseMirror').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await rests.nth(1).locator('.ui-block-text-question').first().click();
    const question = folds.nth(1).getByLabel('Vraag', { exact: true }).first();
    await expect(question).toBeFocused();

    // As an accordion its answers fold at rest: the keyboard folds without opening the block, and
    // "Edit" is a separate stop.
    await question.fill('Waarom nu?');
    await folds.nth(1).locator('details.ui-block-group > summary').click();
    await folds.nth(1).getByLabel('Variant').selectOption({ label: 'Uitklapbaar' });
    await done(1);
    const summary = rests.nth(1).locator('details > summary').first();
    await expect(summary).toHaveText('Waarom nu?');
    await expect(rests.nth(1).locator('strong')).toBeHidden();
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(rests.nth(1).locator('strong')).toHaveText('het');
    await expect(folds.nth(1)).not.toHaveAttribute('open', '');
    await summary.click();
    await expect(rests.nth(1).locator('strong')).toBeHidden();
    await expect(folds.nth(1)).not.toHaveAttribute('open', '');

    // All of it survives the save.
    await page.getByRole('button', { name: 'Opslaan' }).first().click();
    await expect(page.getByRole('status').first()).toContainText('Opgeslagen');
    await expect(box.locator('.ui-block-text-kind')).toHaveText('Waarschuwing');
    await expect(box.locator('strong')).toHaveText('vette');
    await expect(rests.nth(1).locator('details > summary').first()).toHaveText('Waarom nu?');
    await expect(rests.nth(2).locator('.ui-block-text-action').nth(1)).toHaveText('Lees meer');
    await expect(rests.locator('a[href]')).toHaveCount(0);
  });

  /** The seeded page, open, watching for a request to a video host. */
  const videoAndFormAtRest = async (page: Page, request: APIRequestContext) => {
    const hosts: string[] = [];
    page.on('request', (r) => {
      if (/youtube|youtu\.be|vimeo/.test(r.url())) hosts.push(r.url());
    });
    const edit = await seededPage(request);
    await login(page, edit);
    const video = card(page, 11).locator('[data-block-rest]');
    const form = card(page, 12).locator('[data-block-rest]');
    return { hosts, video, form };
  };

  test('a video and a form open at their first field, and say what changed', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const { hosts, video, form } = await videoAndFormAtRest(page, request);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const url = page.url();
    // A click on the preview's button goes to the block's first field: no post, no navigation.
    const posts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST') posts.push(r.url());
    });
    await form.locator('.ui-block-text-action').click();
    const id = card(page, 12).getByLabel('Formulier-id');
    await expect(id).toBeFocused();
    expect(page.url()).toBe(url);
    expect(posts).toEqual([]);
    // The screen cannot look a new reference up, so it says so instead of showing the old form.
    const changed = form.locator('.ui-block-text-changed');
    await expect(changed).toBeHidden();
    await id.fill('01a17235-f9c5-7c70-908a-7103f7f10566');
    await page.keyboard.press('Escape');
    await expect(changed).toBeVisible();
    // A video follows its title and host when it closes.
    await video.locator('.ui-block-text-title').click();
    const fold = card(page, 11);
    await expect(fold.getByLabel('Titel', { exact: true })).toBeFocused();
    await fold.getByLabel('Titel', { exact: true }).fill('Een andere titel');
    await page.keyboard.press('Escape');
    await expect(video.locator('.ui-block-text-title')).toHaveText('Een andere titel');
    expect(hosts).toEqual([]);
  });

  test('a click on the words of a paywall opens nothing', async ({ page, request }) => {
    onlyA11y();
    await login(page, await seededPage(request));
    await editorReady(page);
    const boundary = card(page, 4).locator('[data-block-rest] .ui-block-text-boundary');
    // A click on the words opens nothing, and the page stays where it is.
    const url = page.url();
    await boundary.click();
    expect(page.url()).toBe(url);
    await expect(page.locator('details.block[open]')).toHaveCount(0);
  });

  /** A page with a legacy hero that has an image, open; the seeded page must be on screen. */
  const legacyHeroPage = async (page: Page, request: APIRequestContext) => {
    const src = await card(page, 5)
      .locator('[data-block-rest] img[data-block-image]')
      .getAttribute('src');
    const mediaId = /\/media\/([0-9a-f-]{36})\//.exec(src ?? '')?.[1];
    expect(mediaId).toBeTruthy();

    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `c4-hero-${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Schone lucht' },
        blocks: [
          {
            type: 'hero',
            version: 1,
            props: {
              variant: 'cover',
              title: { nl: 'Schone lucht' },
              body: { nl: 'Doe mee met de buurt.' },
              image: {
                mediaId,
                decorative: false,
                alt: { nl: 'Een plein' },
                caption: { nl: 'Geen bijschrift in deze weergave' },
              },
              actions: [
                {
                  label: { nl: 'Lees meer' },
                  target: { kind: 'url', url: 'https://example.org/' },
                },
              ],
            },
          },
        ],
      },
    });
    await page.goto(`/admin/probe/content/${item.id}`);
    return page.locator('[data-block-rest]').first();
  };

  test('a legacy hero shows its picture and the way into the header', async ({ page, request }) => {
    await login(page, await seededPage(request));
    await expect(card(page, 6).locator('[data-block-rest]')).toContainText('ouder openingsblok');
    const rest = await legacyHeroPage(page, request);
    await expectPixels(rest.locator('img[data-block-image]'), 'the legacy hero at rest');
    const move = rest.getByRole('link', { name: 'Verplaats het naar de kop' });
    await expect(move).toHaveAttribute('href', '#hero-conversion');
    await expect(page.locator('#hero-conversion')).toContainText(/kop/i);
    await page.setViewportSize(NARROW);
    for (const size of TEXT_SIZES) {
      await setTextSize(page, size);
      await layoutGate(page, `legacy hero at rest at ${size}`, '.item-blocks');
    }
    await setTextSize(page, '100%');
    await page.setViewportSize({ width: 1280, height: 900 });
    await expectNoAxeViolations(page);
  });

  test('a legacy hero opens at its title and shows what was typed when it closes', async ({
    page,
    request,
  }) => {
    onlyA11y();
    await login(page, await seededPage(request));
    const rest = await legacyHeroPage(page, request);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    // A click on the title goes to its field; closing shows what was typed.
    await rest.locator('.ui-block-text-heading').click();
    const fold = page.locator('details.block').first();
    await expect(fold.getByLabel('Titel', { exact: true }).first()).toBeFocused();
    await fold.getByLabel('Titel', { exact: true }).first().fill('Frisse lucht');
    await page.keyboard.press('Escape');
    await expect(rest.locator('.ui-block-text-heading')).toHaveText('Frisse lucht');
  });

  test('on a long page a change, a closed fold, a move and a save stay where the editor is', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { itemId, edit } = await pictureAtBothEnds(page, request, 'c-long');
    await page.goto(edit);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const titles = page.locator('.ui-block-card-title');
    const inView = async (at: Locator) => {
      await expect
        .poll(() => page.evaluate(() => scrollY), 'not at the page top')
        .toBeGreaterThan(400);
      await expect(at).toBeInViewport();
    };

    // The picture on top is closed and shows itself and its caption.
    await expect(page.locator('details.block[open]')).toHaveCount(0);
    await expectPixels(
      card(page, 1).locator('[data-block-rest] img[data-block-image]'),
      'the top image at rest'
    );
    await expect(card(page, 1).locator('[data-block-rest]')).toContainText('Bovenaan');
    const geometry = await page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight },
      scrollHeight: document.documentElement.scrollHeight,
      cards: [...document.querySelectorAll('.ui-block-card:has(figure.ui-block-image)')].map(
        (card) => {
          const image = card.querySelector('img[data-block-image]')!;
          const figure = card.querySelector('figure.ui-block-image')!;
          return {
            cardHeight: card.getBoundingClientRect().height,
            figureHeight: figure.getBoundingClientRect().height,
            thumbnail: {
              width: image.getBoundingClientRect().width,
              height: image.getBoundingClientRect().height,
            },
          };
        }
      ),
    }));
    expect(geometry.cards).toHaveLength(2);
    expect(geometry.cards.every((entry) => entry.thumbnail.height <= 72)).toBe(true);
    await test.info().attach('compact-long-page-geometry.json', {
      body: JSON.stringify({ ...geometry, browser: page.context().browser()?.version() }),
      contentType: 'application/json',
    });

    // A text halfway, closed again: its rest follows, the page does not move.
    const middle = card(page, 8);
    await middle.locator('details.block > summary').click();
    await middle.getByLabel('Tekst', { exact: true }).fill('Gewijzigd halverwege');
    await page.keyboard.press('Escape');
    await expect(middle.locator('[data-block-rest]')).toHaveText('Gewijzigd halverwege');
    await inView(middle);

    // Another picture, opened and closed: its rest shows the caption the save will keep.
    const last = card(page, 14);
    await last.locator('details.block > summary').click();
    await last
      .locator('input[name$=".p.caption.nl"], textarea[name$=".p.caption.nl"]')
      .fill('Onderaan gewijzigd');
    await page.keyboard.press('Escape');
    await expect(last.locator('[data-block-rest] figcaption')).toContainText('Onderaan gewijzigd');
    await inView(last);

    // A move saves what was typed and lands at the block.
    await middle.locator('details.ui-block-card-more > summary').click();
    await middle.getByRole('button', { name: 'Omhoog', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Blok verplaatst.');
    await expect(titles.nth(6)).toHaveText('Blok 07 Kop');
    await expect(card(page, 7).locator('[data-block-rest]')).toHaveText('Gewijzigd halverwege');
    await inView(card(page, 7));

    // A save with nothing left to land at stays at the card in view, not at the page top.
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await inView(card(page, 7));
    await expect(page.locator('details.block[open]')).toHaveCount(0);

    const { revision } = await callApi<{
      revision: {
        document: { blocks: { props: { text?: { nl: string }; caption?: { nl: string } } }[] };
      };
    }>(request, 'content.item.get', { itemId });
    const saved = revision.document.blocks;
    expect(saved[6]?.props.text?.nl).toBe('Gewijzigd halverwege');
    expect(saved[13]?.props.caption?.nl).toBe('Onderaan gewijzigd');
    expect(saved[0]?.props.caption?.nl).toBe('Bovenaan');
  });

  test('a refused save opens the closed block, keeps the rest and leads to the field', async ({
    page,
    request,
  }) => {
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `c-refused-${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Weigering' },
        blocks: [
          { type: 'heading', version: 1, props: { text: { nl: 'Wordt leeg' } } },
          { type: 'heading', version: 1, props: { text: { nl: 'Blijft dicht' } } },
        ],
      },
    });
    await login(page, `/admin/probe/content/${item.id}`);
    const first = card(page, 1);
    await first.locator('details.block > summary').click();
    await first.getByLabel('Tekst', { exact: true }).fill('');
    await first.locator('details.block > summary').click();
    const second = card(page, 2);
    await second.locator('details.block > summary').click();
    await second.getByLabel('Tekst', { exact: true }).fill('Getypt in het andere blok');
    await second.locator('details.block > summary').click();
    await page.locator('#title\\.nl').fill('Getypte titel');
    await expect(first.locator('details.block')).not.toHaveAttribute('open', '');

    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Het blok kon niet worden opgeslagen');
    await expect(first.locator('details.block')).toHaveAttribute('open', '');
    await expect(page.locator('#title\\.nl')).toHaveValue('Getypte titel');
    await expect(card(page, 2).locator('details.block')).not.toHaveAttribute('open', '');
    await expect(card(page, 2).getByLabel('Tekst', { exact: true })).toHaveValue(
      'Getypt in het andere blok'
    );
    // By keyboard: the link in the summary reaches the refused field.
    const link = alert.getByRole('link', { name: /Tekst/ });
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(first.getByLabel('Tekst', { exact: true })).toBeFocused();
    await expectNoAxeViolations(page);
  });

  // #130: an emptied rich-text field is absent on both routes. The editor empties it with the
  // script, the textarea without.
  async function emptyProse(fold: Locator) {
    if (isA11y()) {
      await fold.locator('.ProseMirror').first().click();
      await fold.page().keyboard.press('ControlOrMeta+a');
      await fold.page().keyboard.press('Delete');
    } else await fold.getByRole('textbox').last().fill('');
  }
  const prose = (text: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  });

  localeEvidenceTest(
    'a rich-text field emptied in one locale falls back, and that locale cannot publish',
    async ({ page, request }) => {
      requireApi();
      const evidence = settingsEvidence(test.info());
      evidence.watch('A', page);
      try {
        const { item } = await evidence.step('create bilingual rich-text page', () =>
          callApi<{ item: { id: string } }>(request, 'content.item.create', {
            slug: `c-blank-${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`,
            document: {
              type: 'page',
              defaultLocale: 'nl',
              locales: ['nl', 'en'],
              title: { nl: 'Leeg', en: 'Blank' },
              blocks: [
                {
                  type: 'rich-text',
                  version: 1,
                  props: {
                    content: { nl: prose('Nederlandse woorden'), en: prose('English words') },
                  },
                },
              ],
            },
          })
        );
        // Act only on a ready editor, and read only once the next screen is there.
        await evidence.step('log in to English content locale', async () => {
          await login(page, `/admin/probe/content/${item.id}?locale=en`);
          await editorReady(page);
        });
        const fold = card(page, 1).locator('details.block');
        await evidence.step('open rich-text block disclosure', () =>
          fold.locator('> summary').click()
        );
        await evidence.step('empty English rich-text field', () => emptyProse(fold));
        await evidence.step('save emptied English rich text', () =>
          reloadsEditor(page, () =>
            page.getByRole('button', { name: 'Opslaan', exact: true }).click()
          )
        );
        await evidence.step('save has no alert', () =>
          expect(page.getByRole('alert')).toHaveCount(0)
        );

        const { revision } = await evidence.step('read saved revision', () =>
          callApi<{
            revision: { id: string; document: { blocks: { props: { content: object } }[] } };
          }>(request, 'content.item.get', { itemId: item.id })
        );
        await evidence.step('saved revision keeps only Dutch rich text', async () => {
          expect(revision.document.blocks[0]!.props.content).toEqual({
            nl: prose('Nederlandse woorden'),
          });
        });
        // On the edit screen the other locale's words stand in, as for a text field.
        await evidence.step('editor displays Dutch fallback', () =>
          expect(card(page, 1)).toContainText('Nederlandse woorden')
        );
        // Publicly there is no fallback (ADR 018): the locale is refused, nothing blank goes out.
        const probe = await evidence.step('resolve tenant for publication', () => tenantId());
        const refusal = await evidence.step('attempt English publication', () =>
          withInvoker((invoker) =>
            invoker
              .run(useCases.publishItem, systemPrincipal(probe, 'e2e'), {
                itemId: item.id,
                revisionId: revision.id,
                locale: 'en',
              })
              .then(
                () => null,
                (e: UseCaseError) => e
              )
          )
        );
        await evidence.step('publication refuses missing English translation', async () => {
          expect(refusal?.issues).toContainEqual(
            expect.objectContaining({ message: 'content.publish.missing-translation' })
          );
        });
      } finally {
        await evidence.attach();
      }
    }
  );

  test('a rich-text block with no words in any locale is refused, and the summary reaches it', async ({
    page,
    request,
  }) => {
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `c-noword-${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Geen woorden' },
        blocks: [
          { type: 'rich-text', version: 1, props: { content: { nl: prose('Wordt leeg') } } },
        ],
      },
    });
    await login(page, `/admin/probe/content/${item.id}`);
    await editorReady(page);
    const fold = card(page, 1).locator('details.block');
    await fold.locator('> summary').click();
    await emptyProse(fold);
    await reloadsEditor(page, () =>
      page.getByRole('button', { name: 'Opslaan', exact: true }).click()
    );
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Het blok kon niet worden opgeslagen');
    // The field holds what was typed: nothing, not the words it loaded.
    if (isA11y()) await expect(card(page, 1).locator('.ProseMirror')).toHaveText('');
    else await expect(fold.getByRole('textbox').first()).toHaveValue('');
    const link = alert.getByRole('link').first();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(fold.getByRole('textbox').first()).toBeFocused();
    await expectNoAxeViolations(page);
  });

  test('a question cleared above an untouched answer is refused, and the answer stays', async ({
    page,
    request,
  }) => {
    requireApi();
    const entries = [
      { question: { nl: 'Vraag een?' }, answer: { nl: prose('Antwoord een.') } },
      { question: { nl: 'Vraag twee?' }, answer: { nl: prose('Antwoord twee.') } },
    ];
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `c-question-${isA11y() ? 'a11y' : 'no-js'}-${Date.now()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Vragen' },
        blocks: [{ type: 'faq', version: 2, props: { variant: 'list', entries } }],
      },
    });
    await login(page, `/admin/probe/content/${item.id}`);
    const fold = card(page, 1).locator('details.block');
    await fold.locator('> summary').click();
    await fold.getByLabel('Vraag', { exact: true }).first().fill('');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Het blok kon niet worden opgeslagen');

    // Nothing was dropped: neither on the screen nor in the stored revision.
    const answer = card(page, 1).locator('textarea[name$="entries.0.answer.nl"]');
    await expect(answer).toHaveValue('Antwoord een.');
    if (isA11y())
      await expect(card(page, 1).locator('.ProseMirror').first()).toHaveText('Antwoord een.');
    const { revision } = await callApi<{
      revision: { document: { blocks: { props: { entries: object[] } }[] } };
    }>(request, 'content.item.get', { itemId: item.id });
    expect(revision.document.blocks[0]!.props.entries).toEqual(entries);
  });

  test('a paywall lands on its actions after a move, and its removal says why it cannot go', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `c-paywall-${Date.now()}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Voor leden' },
        access: { level: 'members', teaser: 'marker' },
        blocks: [
          { type: 'heading', version: 1, props: { text: { nl: 'Voor iedereen' } } },
          { type: 'paywall', version: 1, props: {} },
          { type: 'heading', version: 1, props: { text: { nl: 'Voor leden' } } },
        ],
      },
    });
    await login(page, `/admin/probe/content/${item.id}`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await card(page, 2).locator('details.ui-block-card-more > summary').click();
    await card(page, 2).getByRole('button', { name: 'Omlaag', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Blok verplaatst.' })).toContainText(
      'Blok verplaatst.'
    );
    const paywall = card(page, 3);
    await expect(paywall.locator('.ui-block-card-title')).toHaveText('Blok 03 Betaalmuur');
    await expect(paywall.locator('details.ui-block-card-more > summary')).toBeFocused();

    await paywall.locator('details.ui-block-card-more > summary').click();
    await paywall.getByRole('button', { name: 'Verwijderen', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert.getByRole('link', { name: 'Wat alle anderen zien' })).toBeVisible();
    await expect(alert.locator('li')).not.toBeEmpty();
    await expect(page.locator('.ui-block-card-title').nth(2)).toHaveText('Blok 03 Betaalmuur');
    await alert.getByRole('link', { name: 'Wat alle anderen zien' }).click();
    await expect(page.locator('#teaser')).toBeFocused();
  });

  test("a picture's caption at rest follows its mode, as the save will read it", async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { edit, itemId, mediaId } = await pictureAtBothEnds(page, request, 'c-caption');
    const { caption: before } = await callApi<{ caption: Record<string, string> }>(
      request,
      'media.get',
      { id: mediaId }
    );
    await callApi(request, 'media.update', { id: mediaId, caption: { nl: 'Van het bestand' } });
    try {
      await page.goto(edit);
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      const pic = card(page, 1);
      const caption = pic.locator('[data-block-rest] figcaption');
      const set = async (mode: 'inherit' | 'hide' | 'own', words?: string) => {
        await pic.locator('details.block > summary').click();
        await pic.locator('select[name$=".p.caption.nl.mode"]').selectOption(mode);
        if (words !== undefined)
          await pic.locator('[name$=".p.caption.nl"]:not(select)').fill(words);
        await page.keyboard.press('Escape');
      };
      await expect(caption).toContainText('Bovenaan');

      await set('own', 'Eigen woorden');
      await expect(caption).toContainText('Eigen woorden');
      await set('inherit');
      await expect(caption).toContainText('Van het bestand');
      await set('hide');
      await expect(pic.locator('[data-rest-caption]')).toBeHidden();
      // Own, with no words: a save stores it empty, which hides the file's.
      await set('own', '');
      await expect(pic.locator('[data-rest-caption]')).toBeHidden();

      // What the rest said is what comes back.
      await set('inherit');
      await expect(caption).toContainText('Van het bestand');
      await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
      await expect(page).toHaveURL(/\?saved/);
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      await expect(card(page, 1).locator('[data-block-rest] figcaption')).toContainText(
        'Van het bestand'
      );
      const { revision } = await callApi<{
        revision: { document: { blocks: { props: { caption?: unknown } }[] } };
      }>(request, 'content.item.get', { itemId });
      expect(revision.document.blocks[0]?.props.caption).toBeUndefined();
    } finally {
      await callApi(request, 'media.update', { id: mediaId, caption: before });
    }
  });

  test('a picture that does not load says so, and its reference stays', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { itemId, edit, mediaId } = await pictureAtBothEnds(page, request, 'd-broken');
    const { item: hero } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `d-broken-hero-${Date.now()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Kapotte hero' },
        blocks: [
          {
            type: 'hero',
            version: 1,
            props: {
              variant: 'cover',
              title: { nl: 'Schone lucht' },
              image: { mediaId, decorative: false, alt: { nl: 'Een plein' } },
            },
          },
        ],
      },
    });
    await page.route(`**/media/${mediaId}/**`, (route) => route.abort());

    // An image block: the words and the way out, no working-looking picture.
    await page.goto(edit);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const figure = card(page, 1).locator('figure.ui-block-image');
    await expect(figure).toHaveAttribute('data-broken', '');
    await expect(figure.locator('img[data-block-image]')).toBeHidden();
    const note = figure.locator('.ui-block-image-missing');
    await expect(note).toBeVisible();
    await note.getByRole('link', { name: 'Beeld vervangen' }).click();
    await expect(card(page, 1).locator('details.block')).toHaveAttribute('open', '');
    await expect(page).toHaveURL(/#b-[0-9a-f-]+-p-mediaId$/);
    // Saved as it stands: the reference is not touched by a request that failed.
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    const { revision } = await callApi<{
      revision: { document: { blocks: { props: { mediaId?: string } }[] } };
    }>(request, 'content.item.get', { itemId });
    expect(revision.document.blocks[0]?.props.mediaId).toBe(mediaId);

    // A legacy hero's picture says the same, and "Replace" reaches its own field.
    await page.goto(`/admin/probe/content/${hero.id}`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const heroFigure = card(page, 1).locator('figure.ui-block-image');
    await expect(heroFigure).toHaveAttribute('data-broken', '');
    await heroFigure.getByRole('link', { name: 'Beeld vervangen' }).click();
    await expect(page).toHaveURL(/#b-[0-9a-f-]+-p-image-mediaId$/);
    const field = decodeURIComponent(new URL(page.url()).hash);
    await expect(page.locator(field)).toBeAttached();
    await expect(card(page, 1).locator('details.block')).toHaveAttribute('open', '');
  });

  test('an FAQ rebuilt on the other locale keeps the words of its untouched fields', async ({
    page,
    request,
  }) => {
    test.skip(!isA11y(), 'closing a block changes the rest view only with the script');
    const prose = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `c2-fallback-${Date.now()}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Vragen', en: 'Questions' },
        blocks: [
          {
            type: 'faq',
            version: 2,
            props: {
              variant: 'list',
              entries: [
                { question: { nl: 'Vraag een?' }, answer: { nl: prose('Antwoord een.') } },
                { question: { nl: 'Vraag twee?' }, answer: { nl: prose('Antwoord twee.') } },
              ],
            },
          },
          {
            type: 'callout',
            version: 1,
            props: { variant: 'warning', body: { nl: prose('Pas op.') } },
          },
          {
            type: 'callout',
            version: 1,
            props: { variant: 'note', body: { nl: prose('Ter info.') } },
          },
          {
            type: 'cta',
            version: 1,
            props: {
              variant: 'card',
              title: { nl: 'Doe mee' },
              actions: [
                {
                  label: { nl: 'Teken' },
                  target: { kind: 'url', url: 'https://example.org/teken' },
                },
              ],
            },
          },
        ],
      },
    });
    const edit = `/admin/probe/content/${item.id}`;
    await login(page, `${edit}?locale=en`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const rest = page.locator('[data-block-rest]').first();
    const fold = page.locator('details.block').first();
    const faq = rest.locator('.ui-block-text-faq');
    const open = async () => {
      await fold.locator('> summary').click();
      await expect(fold).toHaveAttribute('open', '');
      await expect(fold.getByLabel('Vraag', { exact: true }).first()).toBeVisible();
    };
    const close = () => fold.locator('[data-block-done] button').click();

    // Only the variant changes: every row keeps its fallback words, as a fold now.
    await open();
    await fold.locator('details.ui-block-group > summary').click();
    await fold.getByLabel('Variant').selectOption('accordion');
    await close();
    await expect(faq).toHaveAttribute('data-variant', 'accordion');
    await expect(rest.locator('summary')).toHaveText(['Vraag een?', 'Vraag twee?']);
    await expectNoAxeViolations(page);

    // One question translated: that row says the new words, the other keeps the fallback, and
    // its answer stays the server's rendering.
    await rest.locator('summary').first().click();
    await open();
    await fold.getByLabel('Vraag', { exact: true }).first().fill('Question one?');
    await close();
    await expect(rest.locator('summary')).toHaveText(['Question one?', 'Vraag twee?']);
    await expect(rest.locator('.ui-block-text-prose').first()).toContainText('Antwoord een.');

    // Emptied again, the field holds what it loaded: nothing typed, so the fallback, as the save
    // will keep it.
    await open();
    await fold.getByLabel('Vraag', { exact: true }).first().fill('');
    await close();
    await expect(rest.locator('summary')).toHaveText(['Vraag een?', 'Vraag twee?']);

    // A warning and a note in their boxes, and a CTA card, pass axe in their own colours.
    await expect(page.locator('.ui-block-text-callout[data-variant="warning"]')).toBeVisible();
    await expect(page.locator('.ui-block-text-callout[data-variant="note"]')).toBeVisible();
    await expect(page.locator('.ui-block-text-cta[data-variant="card"]')).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test('an image block shows its picture with caption and credit at rest, its layout under Display', async ({
    page,
    request,
  }) => {
    const edit = await seededPage(request);
    await login(page, edit);
    const image = card(page, 5);
    await expect(image.locator('.ui-block-card-title')).toHaveText('Blok 05 Afbeelding');
    await expectPixels(
      image.locator('[data-block-rest] img[data-block-image]'),
      'the image block at rest'
    );
    const rest = image.locator('figure.ui-block-image');
    await expect(rest.locator('[data-rest-alt]')).toContainText('Beschrijving (alt-tekst)');
    await expect(rest.locator('[data-rest-alt-text]')).not.toBeEmpty();
    const thumbnail = await rest.locator('img[data-block-image]').boundingBox();
    expect(thumbnail?.width).toBeLessThanOrEqual(96);
    expect(thumbnail?.height).toBeLessThanOrEqual(72);
    const preview = rest.locator('.ui-block-image-preview');
    await expect(preview.locator('img')).toBeHidden();
    await preview.locator('summary').click();
    await expectPixels(preview.locator('img'), 'the requested larger preview');
    await preview.locator('summary').click();
    const fields = image.locator('details.block');
    await fields.locator(':scope > summary').click();
    // Content first; layout and credit folded until asked for.
    await expect(fields.getByLabel('Plaatsing')).toBeHidden();
    await fields.locator('details.ui-block-group > summary', { hasText: 'Weergave' }).click();
    await expect(fields.getByLabel('Plaatsing')).toBeVisible();
    await expect(
      fields.locator('details.ui-block-group > summary', { hasText: 'Bron en credits' })
    ).toBeVisible();
    // Evidence for the PR's UI gate: the card at rest and opened, at 320 CSS px and 200% text.
    if (isA11y()) {
      await page.setViewportSize(NARROW);
      await setTextSize(page, '200%');
      await layoutGate(page, 'image card opened', '#item-edit');
      await image.screenshot({ path: test.info().outputPath('image-card-open-320-200.png') });
      await fields.locator(':scope > summary').click();
      await (await more(page, 5)).locator('details.ui-block-card-more > summary').focus();
      await layoutGate(page, 'image card at rest with more actions', '#item-edit');
      await image.screenshot({ path: test.info().outputPath('image-card-rest-320-200.png') });
      // Long metadata stays complete, while the ordinary thumbnail remains compact.
      await fields.locator(':scope > summary').click();
      const description = 'Een plein vol mensen met spandoeken. '.repeat(12).trim();
      await fields.locator('[data-block-alt] > summary').click();
      await fields.locator('[name$=".p.alt.nl"]').fill(description);
      await fields.locator(':scope > summary').click();
      await expect(rest.locator('[data-rest-alt-text]')).toHaveText(description);
      await layoutGate(page, 'complete long image description', '#item-edit');
      await image.screenshot({ path: test.info().outputPath('image-card-long-alt-320-200.png') });
    }
  });

  test.describe('UI gate: the block forms at 320 CSS px and 200% text', () => {
    test.use({ viewport: NARROW });

    for (const text of TEXT_SIZES)
      test(`every action whole and no horizontal scroll, text ${text}`, async ({
        page,
        request,
      }) => {
        onlyA11y('measures the layout with a script');
        const edit = await seededPage(request);
        // A committed URL can precede the HTML body. Throttled delivery keeps that window
        // observable without sleeps; restore normal networking once the document is parsed.
        const network = await page.context().newCDPSession(page);
        await network.send('Network.enable');
        await network.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 20,
          downloadThroughput: 128 * 1024,
          uploadThroughput: 128 * 1024,
        });
        await login(page, edit);
        const form = page.locator('form#item-edit');
        await expect(form).toBeVisible();
        await expect(form.locator('input[name="baseRevisionId"]')).toHaveValue(/.+/);
        await page.waitForLoadState('domcontentloaded');
        await network.detach();
        // Mounting the prose editor and the tab enhancement is observable readiness, unlike
        // the URL or body alone. Open folds afterwards so hydration cannot replace the state.
        await expect(form.locator('details.block').nth(2).locator('.ProseMirror')).toHaveCount(1);
        await expect(form.locator('.ui-tabs')).toHaveAttribute('data-tabs', '');
        await page.evaluate(() =>
          document.querySelectorAll('details').forEach((d) => (d.open = true))
        );
        const blocks = form.locator('details.block');
        // One card per type, one fold less: a paywall has no fields to open.
        await expect(form.locator('section.ui-block-card')).toHaveCount(BLOCK_TYPES.length);
        await expect(blocks).toHaveCount(BLOCK_TYPES.length - 1);
        await expect(form.locator('details.block:not([open])')).toHaveCount(0);
        await expect(blocks.nth(2).locator('.ProseMirror')).toBeVisible();
        await expect(card(page, 9).getByLabel('Vraag', { exact: true }).first()).toBeVisible();
        await setTextSize(page, text);
        await expect(page).toHaveURL(new RegExp(`${edit}$`));
        await layoutGate(page, edit);
        // A block with many fields, chosen but not stored, at its place. Not the hero: new content
        // gets no hero block (ADR 025 rule 4).
        await page.goto(edit);
        await insert(page, 'Oproep', 'after', 7);
        await expect(form.locator('.ui-tabs')).toHaveAttribute('data-tabs', '');
        await expect(
          page.locator('#block-new').getByLabel('Titel', { exact: true }).first()
        ).toBeVisible();
        await setTextSize(page, text);
        await layoutGate(page, 'new cta');
      });
  });
});

// Block cards in the edit screen (#66 PR 3, MY-110 A, #159): a head that names the block, a menu of
// whole actions, rest and edit, and collapsing as an enhancement.
test.describe('block cards', () => {
  test.use({ locale: 'nl-NL' });

  /** Stores a new heading at the end of the page through the one form. */
  async function addHeading(page: Page, text: string) {
    await page
      .locator('[data-block-picker]')
      .last()
      .getByRole('button', { name: 'Kop', exact: true })
      .click();
    const fresh = page.locator('#block-new');
    await expect(fresh.getByRole('heading')).toHaveText('Nieuw blok: Kop');
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    // With the script, its landing moves focus into the new block.
    if (isA11y()) await expect(fresh.getByLabel('Tekst', { exact: true })).toBeFocused();
    await fresh.getByLabel('Tekst', { exact: true }).fill(text);
    await page.getByRole('button', { name: 'Toevoegen en opslaan' }).click();
    await expect(page.getByText(text).first()).toBeVisible();
  }

  test('a block rests until Edit, Escape and Done close it with what was typed, and focus follows actions', async ({
    page,
  }) => {
    onlyA11y('Escape, Done and the focus after a round trip are the script');
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'rest');
    for (const text of ['Eerste', 'Tweede', 'Derde']) {
      await addHeading(page, text);
    }
    await page.goto(edit);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const folds = page.locator('details.block');
    await expect(folds.locator(':scope[open]')).toHaveCount(0);
    await expect(page.locator('[data-block-rest]')).toHaveText(['Eerste', 'Tweede', 'Derde']);

    // Edit opens the fields; Escape closes only this block and keeps what was typed.
    const second = folds.nth(1);
    await second.locator(':scope > summary').click();
    await second.getByLabel('Tekst', { exact: true }).fill('Tweede, gewijzigd');
    await page.keyboard.press('Escape');
    await expect(second).not.toHaveAttribute('open', '');
    await expect(second.locator(':scope > summary')).toBeFocused();
    await expect(page.locator('[data-save-state]')).toHaveAttribute('data-current', 'unsaved');
    // A click on the block at rest opens it too; Done under the fields closes it again.
    await card(page, 2).locator('[data-block-rest]').click();
    await expect(second).toHaveAttribute('open', '');
    await expect(second.getByLabel('Tekst', { exact: true })).toHaveValue('Tweede, gewijzigd');
    await second.locator('[data-block-done] button').click();
    await expect(second).not.toHaveAttribute('open', '');
    await expect(second.locator(':scope > summary')).toBeFocused();

    // Move: focus lands on the moved block's More actions, the edit is saved with it.
    await (await more(page, 2)).getByRole('button', { name: 'Omhoog' }).click();
    await expect(page).toHaveURL(/done=blockMoved#block-/);
    await expect(page.locator('[data-block-rest]')).toHaveText([
      'Tweede, gewijzigd',
      'Eerste',
      'Derde',
    ]);
    await expect(card(page, 1).locator('details.ui-block-card-more > summary')).toBeFocused();
    // Escape closes an open More actions and returns to its summary.
    await (await more(page, 1)).locator('details.ui-block-card-more > summary').focus();
    await page.keyboard.press('Escape');
    await expect(card(page, 1).locator('details.ui-block-card-more')).not.toHaveAttribute(
      'open',
      ''
    );
    // Remove: focus lands on the block that took its place.
    const removed = await more(page, 2);
    await removed.getByRole('button', { name: 'Verwijderen' }).click();
    await expect(page).toHaveURL(/done=blockRemoved&undo=[^#]+#block-/);
    await expect(page.locator('[data-block-rest]')).toHaveText(['Tweede, gewijzigd', 'Derde']);
    await expect(folds.nth(1).locator(':scope > summary')).toBeFocused();
    await expectNoAxeViolations(page);
  });

  test('a card collapses and stays recognisable, its fields still save, and what needs attention opens itself (#159)', async ({
    page,
  }) => {
    onlyA11y('collapsing is the script');
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'collapse');
    for (const text of ['Eerste', 'Tweede', 'Derde']) {
      await addHeading(page, text);
    }
    await page.goto(edit);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const second = card(page, 2);
    const content = second.locator('[data-block-content]');
    const toggle = second.locator('[data-block-toggle]');
    await expect(second.locator('.ui-block-card-name')).toHaveText('Tweede');
    await expect(toggle).toHaveAccessibleName('Inklappen');

    // The button: hidden content, the same head, focus stays.
    await toggle.click();
    await expect(content).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAccessibleName('Uitklappen');
    await expect(toggle).toBeFocused();
    await expect(second.locator('.ui-block-card-title')).toHaveText('Blok 02 Kop');
    await expect(second.locator('.ui-block-card-name')).toBeVisible();
    await expectNoAxeViolations(page);
    // Empty space in the head does the same; a control in it does not.
    await second.locator('.ui-block-card-name').click();
    await expect(content).toBeVisible();
    await second.locator('details.ui-block-card-more > summary').click();
    await expect(content).toBeVisible();
    // The menu lies over the content, and goes away on a click elsewhere.
    await expect(second.locator('.ui-block-card-menu')).toBeVisible();
    await page.locator('h3#blocks').click();
    await expect(second.locator('details.ui-block-card-more')).not.toHaveAttribute('open', '');

    // The keyboard: the button is a button.
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(content).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(content).toBeVisible();

    // All of them, and remembered per browser and item, without a change to save.
    await page.getByRole('button', { name: 'Alles inklappen' }).click();
    await expect(page.locator('[data-block-content]:visible')).toHaveCount(0);
    await expect(page.locator('[data-save-state]')).not.toHaveAttribute('data-current', 'unsaved');
    await page.reload();
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await expect(page.locator('[data-block-content]:visible')).toHaveCount(0);
    await page.getByRole('button', { name: 'Alles uitklappen' }).click();
    await expect(page.locator('[data-block-content]:visible')).toHaveCount(3);

    // What was typed in a block that is then collapsed is saved, and its name follows.
    await card(page, 1).locator('details.block > summary').click();
    await card(page, 1).getByLabel('Tekst', { exact: true }).fill('Eerste, gewijzigd');
    await page.keyboard.press('Escape');
    await expect(card(page, 1).locator('.ui-block-card-name')).toHaveText('Eerste, gewijzigd');
    await card(page, 1).locator('[data-block-toggle]').click();
    await card(page, 3).locator('[data-block-toggle]').click();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    // The changed block comes back open as ever; the one nobody touched stays collapsed.
    await expect(card(page, 1).locator('.ui-block-card-name')).toHaveText('Eerste, gewijzigd');
    await expect(card(page, 3).locator('[data-block-content]')).toBeHidden();

    // A move leaves a collapsed block collapsed, with focus on its actions.
    const moved = await more(page, 3);
    await moved.getByRole('button', { name: 'Omhoog' }).click();
    await expect(page).toHaveURL(/done=blockMoved/);
    await expect(card(page, 2).locator('.ui-block-card-name')).toHaveText('Derde');
    await expect(card(page, 2).locator('[data-block-content]')).toBeHidden();
    await expect(card(page, 2).locator('details.ui-block-card-more > summary')).toBeFocused();

    // A `#block-<id>` target opens itself, as a link to it does.
    const id = await card(page, 2).getAttribute('data-block-card');
    await page.goto(`${edit}#${id}`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await expect(card(page, 2).locator('[data-block-content]')).toBeVisible();

    // A field a save cannot take opens the collapsed block around it.
    await card(page, 1).locator('details.block > summary').click();
    await card(page, 1).getByLabel('Tekst', { exact: true }).fill('');
    await page.keyboard.press('Escape');
    await card(page, 1).locator('[data-block-toggle]').click();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(card(page, 1).locator('[data-block-content]')).toBeVisible();
    await expect(card(page, 1).getByLabel('Tekst', { exact: true })).toBeFocused();
  });

  test('a card follows words typed before its fold had finished opening (#184)', async ({
    page,
  }) => {
    onlyA11y('the name follows with the script');
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'name-race');
    await addHeading(page, 'Eerste');
    await page.goto(edit);
    await editorReady(page);
    const field = card(page, 1).getByLabel('Tekst', { exact: true });
    // Open and type in one task, so `toggle` comes after the words: what a busy machine does to
    // someone who starts typing at once, and what made this assertion fail now and then in CI.
    await field.evaluate(async (input: HTMLInputElement) => {
      const fold = input.closest('details')!;
      fold.querySelector<HTMLElement>(':scope > summary')!.click();
      input.value = 'Eerste, gewijzigd';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((opened) => fold.addEventListener('toggle', opened, { once: true }));
    });
    await field.focus();
    await page.keyboard.press('Escape');
    await expect(card(page, 1).locator('[data-block-rest]')).toContainText('Eerste, gewijzigd');
    await expect(card(page, 1).locator('.ui-block-card-name')).toHaveText('Eerste, gewijzigd');
  });

  test('the rail takes the icons of the menu, not those of the page (#163)', async ({ page }) => {
    onlyA11y('the rail is the script');
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'rail-icons');
    await addHeading(page, 'Eerste');
    await page.goto(edit);
    await editorReady(page);
    // The editor starts in the rail by itself, so this is what every editor sees first. The menu
    // hides its labels there and its chevrons with them; the page keeps both.
    await expect(page.locator('html')).toHaveAttribute('data-admin-nav', 'rail');
    await expect(
      page.locator('main details.ui-block-insert > summary > .ui-icon').first()
    ).toBeVisible();
    const icons = page.locator('main summary > .ui-icon:last-child');
    expect(await icons.count()).toBeGreaterThan(0);
    for (const icon of await icons.all()) await expect(icon).not.toHaveCSS('display', 'none');
    const chevrons = page.locator('.admin-sidebar summary > .ui-icon:last-child');
    expect(await chevrons.count()).toBeGreaterThan(0);
    for (const chevron of await chevrons.all()) await expect(chevron).toBeHidden();
  });

  test('"Insert a block below" opens the chooser of the next place (#159)', async ({ page }) => {
    onlyA11y('the focus is the script; the link is a plain fragment without it');
    await login(page, '/admin/probe');
    await blockPage(page, 'insert-below');
    for (const text of ['Eerste', 'Tweede']) {
      await addHeading(page, text);
    }
    const first = await more(page, 1);
    await first.getByRole('link', { name: 'Blok hieronder invoegen' }).click();
    const chooser = page.locator('details.ui-block-insert').nth(1);
    await expect(chooser).toHaveAttribute('open', '');
    await expect(chooser.locator(':scope > summary')).toBeFocused();
    await expect(first.locator('details.ui-block-card-more')).not.toHaveAttribute('open', '');
    await chooser.getByRole('button', { name: 'Citaat', exact: true }).click();
    await expect(page.locator('#block-new').getByRole('heading')).toHaveText('Nieuw blok: Citaat');
  });

  test('without JavaScript nothing collapses and every block stays open (#159)', async ({
    page,
  }) => {
    test.skip(isA11y(), 'the no-js project is the proof');
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'collapse-nojs');
    await addHeading(page, 'Zonder script');
    await page.goto(edit);
    await expect(card(page, 1).locator('[data-block-content]')).toBeVisible();
    await expect(page.locator('[data-block-toggle]:visible')).toHaveCount(0);
    await expect(page.locator('[data-block-bar]')).toBeHidden();
    const opened = await more(page, 1);
    await expect(opened.locator('.ui-block-card-menu')).toBeVisible();
    await expect(opened.getByRole('button', { name: 'Verwijderen' })).toBeVisible();
  });

  for (const [locale, collapse] of [
    ['nl-NL', 'Alles inklappen'],
    ['en-GB', 'Collapse all'],
  ] as const)
    test.describe(`UI gate: the block card head at 320 CSS px and 200% text, ${locale} (#159)`, () => {
      test.use({ viewport: NARROW, locale });

      for (const scheme of ['light', 'dark'] as const)
        test(`head, menu and bar whole, ${scheme}`, async ({ page, request }) => {
          onlyA11y('measures the layout with a script');
          await page.emulateMedia({ colorScheme: scheme });
          const edit = await seededPage(request);
          await login(page, edit);
          const form = page.locator('form#item-edit');
          await expect(form).toHaveAttribute('data-edit-screen', '');
          // Every type, so also the longest names ("Inschrijfformulier (oud)"), and an open menu.
          await setTextSize(page, '200%');
          const opened = await more(page, 2);
          await expect(opened.locator('.ui-block-card-menu')).toBeVisible();
          await layoutGate(page, 'a card with its menu open', 'section.ui-block-card');
          await layoutGate(page, 'the bar above the cards', '[data-block-bar]');
          await opened.screenshot({
            path: test.info().outputPath(`card-menu-320-200-${locale}-${scheme}.png`),
          });
          await page.locator('h3#blocks').click();
          await page.getByRole('button', { name: collapse }).click();
          await expect(page.locator('[data-block-content]:visible')).toHaveCount(0);
          await layoutGate(page, 'every card collapsed', 'section.ui-block-card');
          await page.locator('.item-blocks').screenshot({
            path: test.info().outputPath(`cards-collapsed-320-200-${locale}-${scheme}.png`),
          });
          await expectNoAxeViolations(page);
          // A later test of this project must not find these collapsed.
          await page.evaluate(() => localStorage.clear());
        });
    });

  test('a card the arrow keys select shows a ring, and "Insert a block below" works before prose (#159)', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const prose = (text: string) => ({
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
        },
      },
    });
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `writer-card-${Date.now()}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Artikel met een kaart' },
        blocks: [
          prose('Eerst'),
          { type: 'heading', version: 1, props: { text: { nl: 'Kop een' } } },
          prose('Dan'),
        ],
      },
    });
    await login(page, `/admin/probe/content/${item.id}`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const surface = page.locator('.writing .ProseMirror');
    await expect(surface).toBeVisible();
    const card = surface.locator('section.ui-block-card');
    await expect(card.locator('.ui-block-card-name')).toHaveText('Kop een');

    await surface.getByText('Eerst').click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowDown');
    await expect(surface.locator('.ProseMirror-selectednode > .ui-block-card')).toHaveCount(1);
    await expect(card).toHaveCSS('outline-style', 'solid');
    await expect(card).toHaveCSS('outline-width', '3px');

    // Collapse works inside the writer, and leaves its prose alone.
    await card.locator('[data-block-toggle]').click();
    await expect(card.locator('[data-block-content]')).toBeHidden();
    await expect(surface.getByText('Dan')).toBeVisible();
    await page.getByRole('button', { name: 'Alles uitklappen' }).click();
    await expect(card.locator('[data-block-content]')).toBeVisible();

    // The next block is prose: the writer shows no chooser there, so it comes to this card.
    await card.locator('details.ui-block-card-more > summary').click();
    // The writer's text may wrap anywhere; the menu's words stay whole inside it.
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'a card menu in the writer', '.editor-card');
    await setTextSize(page, '100%');
    await page.setViewportSize({ width: 1280, height: 720 });
    await card.getByRole('link', { name: 'Blok hieronder invoegen' }).click();
    const chooser = surface.locator('details.ui-block-insert[open]');
    await expect(chooser).toBeVisible();
    await expect(chooser.locator(':scope > summary')).toBeFocused();
    await chooser.getByRole('button', { name: 'Citaat', exact: true }).click();
    await expect(page.locator('#block-new').getByRole('heading')).toHaveText('Nieuw blok: Citaat');
  });
});
