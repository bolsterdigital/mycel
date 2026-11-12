// flow: publish
// An operator writes an article: the enhanced writer and pasting save one core document, and a
// row of cards is written in place.

import { randomUUID } from 'node:crypto';
import { capabilitiesFor, systemPrincipal, useCases } from '@mycel/core';
import { principal } from '@mycel/core/testing';
import { type APIRequestContext, type Page, expect } from '@playwright/test';
import { test } from './lib/evidence/page';
import { expectNoAxeViolations, headingOrderProblems } from './lib/axe';
import { asOwner, finishJobs, stuckJob, tenantId, withInvoker } from './lib/invoker';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';
import { closePublication, openPublication } from './lib/publication';
import { isA11y, onlyA11y } from './lib/project';
import { article, articleWithAmbiguousJoin, callApi, requireApi } from './lib/api';
import {
  block,
  blockPage,
  card,
  editorReady,
  more,
  newPage,
  reloadsEditor,
  wipeFirstCard,
} from './lib/editor';

// The enhanced article view and native block forms save the same core document. The browser
// proof covers explicit saving, axe and the action layout at 320 CSS px with 200% text; the no-JS
// project proves the adjacent form can write the same prose without hydrating the editor.
test.describe('article-writing', () => {
  test.use({ locale: 'nl-NL' });

  // ProseMirror reads the selection a moment later: a Backspace before that takes one letter, and
  // the block keeps its words. Rejected: select all, which takes the cards too (#149).
  async function emptyProse(page: Page) {
    const surface = page.locator('.writing-surface .ProseMirror').first();
    const prose = surface.locator('.editor-prose');
    await expect(prose).toBeVisible();
    await expect(async () => {
      // Select text in the writing host, then address the key to that host. A page-wide
      // Backspace can delete the last character of the textarea filled immediately before it.
      await surface.focus();
      await prose.locator('p').first().selectText();
      await expect(surface).toBeFocused();
      await surface.press('Backspace');
      await expect(prose).toHaveText('', { timeout: 1000 });
    }).toPass();
  }

  test('a refused save from a direct locale link keeps English through the next post', async ({
    page,
    request,
  }) => {
    const edit = await article(request);
    await login(page, edit);
    await page.context().clearCookies({ name: 'mycel-content-locale' });
    await page.goto(`${edit}?locale=en`);
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const fold = page.getByRole('group', { name: 'Blok toevoegen', exact: true });
    await fold.getByRole('button', { name: 'Citaat', exact: true }).click();
    const fresh = page.locator('#block-new');
    await fresh.locator('[name="new.p.text.en"]').fill('Incomplete quote');
    if (isA11y()) {
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      await page.locator('.writing-surface .editor-prose p').first().fill('English edited');
    } else {
      await page.locator('[data-native-article] > summary').click();
      const prose = page.locator('details.block').first();
      await prose.locator(':scope > summary').click();
      await prose.getByLabel('Tekst', { exact: true }).fill('English edited');
    }
    await page.locator('[name="title.en"]').fill('English title edited');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('[name="editLocale"]')).toHaveValue('en');
    await expect(page.locator('[name="title.en"]')).toHaveValue('English title edited');
    // Every named action, including publication and the locale switch, must reload this language
    // when refused. Check the native addresses too, rather than only the enhanced Save route.
    const targets = await page
      .locator('main [formaction], form#item-edit')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('formaction') ?? node.getAttribute('action'))
      );
    for (const target of targets)
      expect(new URL(target!, 'http://admin.invalid').searchParams.get('locale')).toBe('en');
    if (isA11y()) {
      await expectNoAxeViolations(page);
      await page.setViewportSize({ width: 320, height: 900 });
      await setTextSize(page, '200%');
      await layoutGate(page, 'refused English save');
      await page.screenshot({ path: test.info().outputPath('refused-save-en-320-200.png') });
    }
    await fresh.getByRole('button', { name: 'Annuleren' }).click();
    await expect(page.locator('#block-new')).toHaveCount(0);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision } = await callApi(request, 'content.item.get', {
      itemId: edit.split('/').at(-1)!,
    });
    expect(revision.document.title).toEqual({ nl: 'Een artikel', en: 'English title edited' });
    const content = revision.document.blocks[0].props.content;
    expect(content.nl.content[0].content[0].text).toBe('Oude tekst');
    expect(content.en.content[0].content[0].text).toBe('English edited');
    expect((await page.context().cookies()).some((c) => c.name === 'mycel-content-locale')).toBe(
      false
    );
  });

  // #142: an empty line in the writer is ordinary writing. With words in another locale the block
  // loses this one and shows the other beside it; in the only locale the block goes and it publishes.
  test('prose emptied in the writer falls back or goes, and nothing blocks the save', async ({
    page,
    request,
  }, info) => {
    test.skip(!isA11y(), 'the writer needs JavaScript; the native route is the #130 test');
    const line = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const create = async (locales: string[], content: Record<string, unknown>) => {
      const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
        slug: `writer-empty-${info.project.name}-${locales.length}-${Date.now()}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales,
          title: Object.fromEntries(locales.map((l) => [l, 'Leeg'])),
          blocks: [
            { type: 'rich-text', version: 1, props: { content } },
            {
              type: 'quote',
              version: 1,
              props: {
                text: Object.fromEntries(locales.map((l) => [l, 'Citaat'])),
                attribution: { name: 'Bron' },
              },
            },
          ],
        },
      });
      return item.id;
    };
    const blocksOf = async (itemId: string) =>
      (
        await callApi<{
          revision: { id: string; document: { blocks: { type: string; props: any }[] } };
        }>(request, 'content.item.get', { itemId })
      ).revision;
    const empty = async () => {
      await emptyProse(page);
      await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
      await expect(page).toHaveURL(/saved/);
    };

    const translated = await create(['nl', 'en'], { nl: line('Nederlands'), en: line('English') });
    await login(page, `/admin/probe/content/${translated}?locale=en`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await empty();
    expect((await blocksOf(translated)).document.blocks[0]!.props.content).toEqual({
      nl: line('Nederlands'),
    });
    const shown = page.locator('.writing-surface .editor-prose').first();
    await expect(shown).toHaveAttribute('data-through', 'Nederlands');
    await expect(shown).toHaveText('');
    await expectNoAxeViolations(page);
    // The hint is no value: another save leaves the locale absent, and typing replaces the hint.
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    expect((await blocksOf(translated)).document.blocks[0]!.props.content).toEqual({
      nl: line('Nederlands'),
    });
    await shown.locator('p').first().click();
    await page.keyboard.type('Eigen');
    await expect(shown).not.toHaveAttribute('data-through');

    const only = await create(['nl'], { nl: line('Wordt leeg') });
    await page.goto(`/admin/probe/content/${only}`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await empty();
    const revision = await blocksOf(only);
    expect(revision.document.blocks.map((b) => b.type)).toEqual(['quote']);
    const probe = await tenantId();
    await withInvoker((invoker) =>
      invoker.run(useCases.publishItem, systemPrincipal(probe, 'e2e'), {
        itemId: only,
        revisionId: revision.id,
        locale: 'nl',
      })
    );
  });

  // #142 review: a block that goes shortens the list, so what follows reads the document that was
  // saved, by id, and not the one the form was opened on.
  // ADR 029. A second actor is the seed API key, so no second login is needed; the screen's own
  // report is read back over the API. `visibilitychange` makes a beat happen now, so a test does
  // not wait twenty seconds for the next one.
  test.describe('presence', () => {
    const report = (request: APIRequestContext, itemId: string, sessionId: string, state: string) =>
      callApi(request, 'content.presence.update', { itemId, sessionId, state });

    test('the first render says who else has the item open, also without JavaScript', async ({
      page,
      request,
    }) => {
      await login(page, '/admin/probe');
      const edit = await article(request);
      const itemId = edit.split('/').at(-1)!;
      await report(request, itemId, randomUUID(), 'editing');
      await page.goto(edit);
      await expect(page.locator('[data-presence]')).toContainText('is aan het bewerken');
    });

    test('who is here follows each beat, and a newer revision is a notice', async ({
      page,
      request,
    }) => {
      onlyA11y();
      await login(page, '/admin/probe');
      const edit = await article(request);
      const itemId = edit.split('/').at(-1)!;
      await page.goto(edit);
      await editorReady(page);
      const presence = page.locator('[data-presence]');
      const agent = randomUUID();
      const beatNow = () =>
        page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      const ownState = async () => {
        const { present } = await callApi(request, 'content.presence.list', { itemId });
        return present.find((p: { actor: { kind: string } }) => p.actor.kind === 'operator')?.state;
      };
      const saveElsewhere = async (nl: string) => {
        const { revision } = await callApi(request, 'content.item.get', { itemId });
        await callApi(request, 'content.item.update', {
          itemId,
          baseRevisionId: revision.id,
          document: { ...revision.document, title: { ...revision.document.title, nl } },
        });
      };

      await report(request, itemId, agent, 'viewing');
      await beatNow();
      await expect(presence).toContainText('kijkt mee');
      await report(request, itemId, agent, 'editing');
      await beatNow();
      await expect(presence).toContainText('is aan het bewerken');
      await expect.poll(ownState).toBe('viewing');

      // A tab without input is offered the newer revision, never a conflict.
      await saveElsewhere('Titel van elders');
      await beatNow();
      const load = presence.getByRole('link', { name: 'Nieuwste versie laden' });
      await expect(load).toBeVisible();
      await expect(presence).toContainText('heeft een nieuwere versie opgeslagen');
      await expectNoAxeViolations(page);
      await page.setViewportSize(NARROW);
      await setTextSize(page, '200%');
      await layoutGate(page, 'newer revision notice');
      await load.click();
      await expect(page.locator('#title\\.nl')).toHaveValue('Titel van elders');
      await editorReady(page);
      await expect(presence.getByRole('link')).toHaveCount(0);

      // A tab with input is told a save merges; loading would cost the input, so it is not offered.
      await page.locator('#title\\.nl').fill('Getypt in dit venster');
      await expect.poll(ownState).toBe('editing');
      await saveElsewhere('Weer van elders');
      await beatNow();
      await expect(presence).toContainText('samengevoegd');
      await expect(presence.getByRole('link')).toHaveCount(0);
    });

    // PR #351 review, F1: a label is not an identity. Two operators with one address is the case
    // that stays possible whatever a key's label looks like, so the collision cannot rot away.
    test('two people with the same label leave the form and its input alone', async ({
      page,
      request,
    }) => {
      onlyA11y();
      await login(page, '/admin/probe');
      const edit = await article(request);
      const itemId = edit.split('/').at(-1)!;
      await page.goto(edit);
      await editorReady(page);
      await page.locator('#title\\.nl').fill('Nog niet opgeslagen');

      const probe = await tenantId();
      await withInvoker(async (invoker) => {
        for (const operatorId of [randomUUID(), randomUUID()]) {
          const sharing = principal({
            tenantId: probe,
            actor: { kind: 'operator', operatorId, email: 'gedeeld@probe.test' },
          });
          await invoker.run(useCases.updatePresence, sharing, {
            itemId,
            sessionId: randomUUID(),
            state: 'editing',
          });
        }
      });
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

      const lines = page.locator('[data-presence] li', { hasText: 'gedeeld@probe.test' });
      await expect(lines).toHaveCount(2);
      await expect(page.locator('form#item-edit')).toHaveCount(1);
      await expect(page.locator('#title\\.nl')).toHaveValue('Nog niet opgeslagen');
    });
  });

  test.describe('after a prose block went', () => {
    test.skip(() => !isA11y(), 'the writer needs JavaScript');

    const line = (text: string) => ({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    });
    const quote = (text: string) => ({
      type: 'quote',
      version: 1,
      props: { text: { nl: text }, attribution: { name: 'Bron' } },
    });
    const stored = async (request: APIRequestContext, itemId: string) =>
      (
        await callApi<{
          revision: {
            document: {
              blocks: {
                id: string;
                type: string;
                props: { text?: { nl?: string }; content?: Record<string, unknown> };
              }[];
            };
          };
        }>(request, 'content.item.get', { itemId })
      ).revision.document.blocks;
    const open = async (
      page: Page,
      request: APIRequestContext,
      blocks: unknown[],
      locales = ['nl']
    ): Promise<string> => {
      const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
        slug: `writer-gone-${test.info().project.name}-${test.info().title.length}-${Date.now()}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales,
          title: { nl: 'Leeg' },
          blocks,
        },
      });
      await login(page, `/admin/probe/content/${item.id}`);
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      return item.id;
    };
    const prose = { type: 'rich-text', version: 1, props: { content: { nl: line('Wordt leeg') } } };
    // A field in a folded card: the fold hides it from `fill`.
    const setField = (page: Page, name: string, value: string) =>
      page.locator(`[name="${name}"]`).evaluate((field, text) => {
        (field as HTMLTextAreaElement).value = text as string;
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }, value);
    const save = (page: Page) => page.getByRole('button', { name: 'Opslaan', exact: true }).click();

    for (const action of ['erase all', 'type over first card', 'undo removal'] as const) {
      test(`a visible card removal: ${action}`, async ({ page, request }) => {
        const itemId = await open(
          page,
          request,
          [
            quote('Blijft alleen na ongedaan maken'),
            {
              ...prose,
              props: { content: { nl: line('Wordt leeg'), en: line('English retained') } },
            },
          ],
          ['nl', 'en']
        );
        await editorReady(page);
        const surface = page.locator('.writing-surface .ProseMirror').first();
        if (action === 'type over first card') {
          // Focus the editor view without DOM focus changing its initial card selection to prose.
          await surface.evaluate((node) => {
            const editor = (node as HTMLElement & { editor: { view: { focus(): void } } }).editor;
            editor.view.focus();
          });
          await page.keyboard.type('Nieuwe tekst');
        } else {
          await surface.focus();
          await surface.press('ControlOrMeta+a');
          await surface.press('Backspace');
        }
        if (action === 'undo removal') await surface.press('ControlOrMeta+z');
        await expect(surface.locator('.editor-card')).toHaveCount(
          action === 'undo removal' ? 1 : 0
        );
        await expectNoAxeViolations(page);
        await save(page);
        await expect(page).toHaveURL(/saved/);
        await page.reload();
        await editorReady(page);
        const saved = await stored(request, itemId);
        expect(saved.filter((block) => block.type === 'quote')).toHaveLength(
          action === 'undo removal' ? 1 : 0
        );
        if (action === 'type over first card') await expect(surface).toContainText('Nieuwe tekst');
        expect(saved.find((block) => block.type === 'rich-text')?.props.content?.en).toEqual(
          line('English retained')
        );
        await expectNoAxeViolations(page);
      });
    }

    test('a refused insert keeps what was typed, and the next save stands', async ({
      page,
      request,
    }) => {
      const itemId = await open(page, request, [prose, quote('Bestaand')]);
      const fold = page.locator('.writing-surface details.ui-block-insert:visible').first();
      await fold.locator('summary').click();
      await fold.getByRole('button', { name: 'Citaat', exact: true }).click();
      const fresh = page.locator('#block-new');
      await expect(fresh.getByRole('heading')).toHaveText('Nieuw blok: Citaat');
      await fresh.locator('[name$=".text.nl"]').fill('Nieuw citaat');

      await emptyProse(page);
      await save(page);
      await expect(page.getByRole('alert')).toBeVisible();
      expect((await stored(request, itemId)).map((b) => b.type)).toEqual(['quote']);
      await expect(fresh.locator('[name$=".text.nl"]')).toHaveValue('Nieuw citaat');

      await fresh.locator('[name="new.p.attribution.name"]').fill('Bron twee');
      await save(page);
      await expect(page).toHaveURL(/\?saved/);
      expect((await stored(request, itemId)).map((b) => b.props.text?.nl)).toEqual([
        'Nieuw citaat',
        'Bestaand',
      ]);
    });

    test('a refusal names the block it is about, and only what changed reopens', async ({
      page,
      request,
    }) => {
      const itemId = await open(page, request, [prose, quote('Een'), quote('Twee')]);
      const before = await stored(request, itemId);
      const [a, b] = [before[1]!.id, before[2]!.id];

      await emptyProse(page);
      await setField(page, `b.${b}.p.text.nl`, '');
      await save(page);
      const alert = page.getByRole('alert');
      await expect(alert).toBeVisible();
      await expect(page.locator(`[name="b.${b}.p.text.nl"]`)).toHaveAttribute(
        'aria-invalid',
        'true'
      );
      await expect(page.locator(`[name="b.${a}.p.text.nl"]`)).not.toHaveAttribute(
        'aria-invalid',
        'true'
      );
      await expect(alert.locator('a').first()).toHaveAttribute(
        'href',
        new RegExp(`^#b-${b}-p-text-nl$`)
      );

      await setField(page, `b.${b}.p.text.nl`, 'Twee en een half');
      await save(page);
      await expect(page).toHaveURL(new RegExp(`[?&]block=${b}(#|$)`));
      expect((await stored(request, itemId)).map((x) => x.props.text?.nl)).toEqual([
        'Een',
        'Twee en een half',
      ]);
    });

    for (const action of ['move', 'remove'] as const)
      test(`${action} on a card goes through with the block gone`, async ({ page, request }) => {
        const itemId = await open(page, request, [prose, quote('Een'), quote('Twee')]);
        const before = await stored(request, itemId);
        const [a, b] = [before[1]!.id, before[2]!.id];

        await emptyProse(page);
        await page
          .locator(
            action === 'move'
              ? `button[name="move"][value="${b}:up"]`
              : `button[name="remove"][value="${a}"]`
          )
          .evaluate((button) => (button as HTMLButtonElement).click());
        await expect(page).toHaveURL(action === 'move' ? /done=blockMoved/ : /done=blockRemoved/);
        const after = action === 'move' ? ['Twee', 'Een'] : ['Twee'];
        expect((await stored(request, itemId)).map((x) => x.props.text?.nl)).toEqual(after);

        // The screen is on the new revision: a further save of it stands and changes nothing.
        await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
        await save(page);
        await expect(page).toHaveURL(/\?saved/);
        expect((await stored(request, itemId)).map((x) => x.props.text?.nl)).toEqual(after);
      });
  });

  // Removing or moving the card between text blocks of different locales would join them and mix
  // up their translations. Core refuses; the writer's save and the card's own buttons (with or
  // without JavaScript) say why, as an issue on the block as a whole, and nothing is saved.
  for (const action of ['writer', 'remove', 'move'] as const)
    test(`${action}: a card whose removal would join text of different locales is refused in words`, async ({
      page,
      request,
    }) => {
      test.skip(action === 'writer' && !isA11y(), 'the writer needs JavaScript');
      const { edit, blocks } = await articleWithAmbiguousJoin(request);
      const before = await blocks();
      const quoteId = before[1]!.id;
      await login(page, edit);
      if (isA11y())
        await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
      if (action === 'writer') {
        await editorReady(page);
        await wipeFirstCard(page);
        await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
      } else
        await page
          .locator(
            action === 'remove'
              ? `button[name="remove"][value="${quoteId}"]`
              : `button[name="move"][value="${quoteId}:down"]`
          )
          .evaluate((button) => (button as HTMLButtonElement).click());
      const alert = page.getByRole('alert');
      await expect(alert).toContainText(
        'dit zou twee tekstblokken samenvoegen die niet dezelfde talen of bloknamen hebben'
      );
      await expect(alert).not.toContainText('Controleer de velden');
      await expect(alert).not.toContainText('de tekst past niet in wat een tekstblok mag bevatten');
      // The issue is about the block as a whole: no link into a field that is not there.
      if (action !== 'writer') {
        await expect(alert).toContainText('Het blok kon niet worden opgeslagen:');
        await expect(alert.locator('li a')).toHaveCount(0);
      }
      expect(await blocks()).toEqual(before);
      if (isA11y()) await expectNoAxeViolations(page);
    });

  test('article prose and title save together, while the native form and other locale remain lossless', async ({
    page,
    request,
  }) => {
    const edit = await article(request);
    await login(page, edit);
    // This proves the save, not input during hydration (the early-input test below does): a fill
    // whose select-all lands while hydration sets the title's value would append to it.
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await page.locator('#title\\.nl').fill('Gewijzigde kop');
    if (isA11y()) {
      await expect(page.locator('.writing-surface .ProseMirror').first()).toBeVisible();
      await page.locator('.writing-surface .editor-prose p').first().fill('Nieuwe tekst');
    } else {
      await page.locator('[data-native-article] > summary').click();
      const prose = page.locator('details.block').first();
      await prose.locator(':scope > summary').click();
      await prose.getByLabel('Tekst', { exact: true }).fill('Nieuwe tekst');
    }
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision } = await callApi(request, 'content.item.get', {
      itemId: edit.split('/').at(-1)!,
    });
    await expect(page.locator(`#block-${revision.document.blocks[0].id}`)).toBeVisible();
    expect(revision.document.title.nl).toBe('Gewijzigde kop');
    expect(revision.document.blocks[0].props.content.nl.content[0].content[0].text).toBe(
      'Nieuwe tekst'
    );
    expect(revision.document.blocks[0].props.content.en.content[0].content[0].text).toBe(
      'Old text'
    );
    if (isA11y()) await expectNoAxeViolations(page);
    await page.goto(`${edit}/write?locale=en`);
    await expect(page).toHaveURL(`${edit}?locale=en#blocks`);
  });

  test('native input typed while the editor bundle loads survives enhancement', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const edit = await article(request);
    await login(page, edit);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/_app/immutable/**/*.js', async (route) => {
      await ready;
      await route.continue();
    });
    await page.reload({ waitUntil: 'commit' });
    await page.locator('#title\\.nl').fill('Voor de enhancement');
    await page.locator('[data-native-article] > summary').click();
    const native = page.locator('details.block').first();
    await native.locator(':scope > summary').click();
    await native.getByLabel('Tekst', { exact: true }).fill('Native invoer voor het laden');
    release();
    await expect(page.locator('form#item-edit[data-edit-screen]')).toHaveCount(1);
    await expect(page.locator('#title\\.nl')).toHaveValue('Voor de enhancement');
    await expect(native.getByLabel('Tekst', { exact: true })).toBeVisible();
    await expect(native.getByLabel('Tekst', { exact: true })).toHaveValue(
      'Native invoer voor het laden'
    );
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const saved = await callApi(request, 'content.item.get', { itemId: edit.split('/').at(-1)! });
    expect(saved.revision.document.title.nl).toBe('Voor de enhancement');
    expect(saved.revision.document.blocks[0].props.content.nl.content[0].content[0].text).toBe(
      'Native invoer voor het laden'
    );
  });

  test('a new page takes its address from its title on the first save, then keeps it', async ({
    page,
    request,
  }) => {
    await login(page, '/admin/probe/content?type=page');
    await page.getByRole('button', { name: 'Nieuwe pagina' }).click();
    await expect(page).toHaveURL(/\/content\/[0-9a-f-]{36}$/);
    const itemId = new URL(page.url()).pathname.split('/').at(-1)!;
    const edit = new URL(page.url()).pathname;
    const start = (await callApi(request, 'content.item.get', { itemId })).item.slug;
    expect(start).toMatch(/^page-[0-9a-f-]{36}$/);
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const stamp = randomUUID().slice(0, 8);
    const title = `Leesbaar adres ${stamp} ${test.info().project.name}`;
    const slug = `leesbaar-adres-${stamp}-${test.info().project.name}`;
    await page.locator('#title\\.nl').fill(title);
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    const side = page.locator('section[aria-labelledby="this-item"]');
    await expect(side).toContainText(`/${slug}`);
    await expect(side).not.toContainText(start);

    // The link picker of another page names it by that address.
    const { item: other } = await callApi(request, 'content.item.create', {
      slug: `a1-picker-${stamp}-${test.info().project.name}`,
      document: {
        type: 'page',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Koppelt' },
        blocks: [
          {
            type: 'cta',
            version: 1,
            props: {
              title: { nl: 'Doe mee' },
              actions: [{ label: { nl: 'Lees' }, target: { kind: 'item', itemId } }],
            },
          },
        ],
      },
    });
    await page.goto(`/admin/probe/content/${other.id}`);
    await expect(page.locator('select[name$=".actions.0.target"] option:checked')).toHaveText(
      `${title} (/${slug})`
    );

    // A second title leaves the address where the first save put it.
    await page.goto(edit);
    if (isA11y())
      await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await page.locator('#title\\.nl').fill(`${title} bis`);
    await page.getByRole('button', { name: 'Opslaan' }).click();
    await expect(page).toHaveURL(`${edit}?saved`);
    expect((await callApi(request, 'content.item.get', { itemId })).item.slug).toBe(slug);
  });

  test('page prose edits inline and saves in the same form as its title', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const source = await article(request);
    const original = await callApi(request, 'content.item.get', {
      itemId: source.split('/').at(-1)!,
    });
    const {
      type: _type,
      authorIds: _authors,
      sectionId: _section,
      tags: _tags,
      corrections: _corrections,
      delivery: _delivery,
      ...document
    } = original.revision.document;
    // Its own slug: from the title it would be one more `een-artikel-n` on every run, and a
    // database that lives on across runs runs out of them at a hundred.
    const created = await callApi(request, 'content.item.create', {
      slug: `page-prose-${Date.now()}`,
      document: { ...document, type: 'page' },
    });
    await login(page, `/admin/probe/content/${created.item.id}`);
    const native = page.locator('details.block').first();
    await native.locator(':scope > summary').click();
    const prose = native.locator('.writing-surface .ProseMirror');
    await expect(prose).toBeVisible();
    await prose.locator('p').first().fill('Inline pagina-inhoud');
    await page.locator('#title\\.nl').fill('Pagina met schrijfvlak');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const saved = await callApi(request, 'content.item.get', { itemId: created.item.id });
    expect(saved.revision.document.title.nl).toBe('Pagina met schrijfvlak');
    expect(saved.revision.document.blocks[0].props.content.nl.content[0].content[0].text).toBe(
      'Inline pagina-inhoud'
    );
    expect(saved.revision.document.blocks[0].props.content.en).toEqual(
      original.revision.document.blocks[0].props.content.en
    );
    await expectNoAxeViolations(page);
  });

  test("a card's insert point stands above it in the writer, and inserts there", async ({
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
    const heading = (text: string) => ({
      type: 'heading',
      version: 1,
      props: { text: { nl: text } },
    });
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `writer-inserts-${Date.now()}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Artikel met kaarten' },
        access: { level: 'members', teaser: 'marker' },
        blocks: [
          prose('Eerst'),
          heading('Kop een'),
          prose('Dan'),
          // A card without fields has no fold, and its "+" belongs above it all the same.
          { type: 'paywall', version: 1, props: {} },
          heading('Kop twee'),
        ],
      },
    });
    const edit = `/admin/probe/content/${item.id}`;
    await login(page, edit);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    const surface = page.locator('.writing .ProseMirror');
    await expect(surface).toBeVisible();

    // One "+" per card, each directly above its card; none left under the writer.
    const shown = page.locator('details.ui-block-insert:visible');
    await expect(shown).toHaveCount(3);
    for (const name of ['Kop een', 'Betaalmuur', 'Kop twee']) {
      const card = surface.locator('section.ui-block-card', { hasText: name });
      await expect(
        card.locator('xpath=preceding-sibling::details[contains(@class, "ui-block-insert")]')
      ).toHaveCount(1);
    }
    await expect(page.locator('.item-blocks fieldset.native-block:visible')).toHaveCount(0);

    // It still does what it says: a new block lands before the card without fields.
    const second = shown.nth(1);
    await second.locator('summary').click();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'insert point in the writer', '.editor-card');
    await setTextSize(page, '100%');
    await page.setViewportSize({ width: 1280, height: 720 });
    await second.getByRole('button', { name: 'Kop', exact: true }).click();
    const fresh = page.locator('#block-new');
    await expect(fresh.getByRole('heading')).toHaveText('Nieuw blok: Kop');
    await fresh.locator('[name$=".text.nl"]').fill('Nieuwe kop');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    const { revision } = await callApi<{
      revision: { document: { blocks: { type: string; props: { text?: { nl?: string } } }[] } };
    }>(request, 'content.item.get', { itemId: item.id });
    expect(revision.document.blocks.map((b) => b.props.text?.nl ?? b.type)).toEqual([
      'rich-text',
      'Kop een',
      'rich-text',
      'Nieuwe kop',
      'paywall',
      'Kop twee',
    ]);
  });

  // The writer saves the whole document, so taking away the only paywall there is one save that
  // must bring the teaser along, as the screen's own remove action does (#230, #231).
  test('the only paywall taken away in the writer saves, and the teaser falls back (#231)', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `writer-paywall-${Date.now()}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Voor leden' },
        lead: { nl: 'Wat iedereen leest.' },
        access: { level: 'members', teaser: 'marker' },
        blocks: [
          {
            type: 'rich-text',
            version: 1,
            props: {
              content: {
                nl: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Iedereen' }] }],
                },
              },
            },
          },
          { type: 'paywall', version: 1, props: {} },
          {
            type: 'rich-text',
            version: 1,
            props: {
              content: {
                nl: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Leden' }] }],
                },
              },
            },
          },
        ],
      },
    });
    const stored = async () =>
      (
        await callApi<{
          revision: { document: { access: { teaser: unknown }; blocks: { type: string }[] } };
        }>(request, 'content.item.get', { itemId: item.id })
      ).revision.document;
    await login(page, `/admin/probe/content/${item.id}`);
    await expect(page.locator('form#item-edit')).toHaveAttribute('data-edit-screen', '');
    await editorReady(page);

    await wipeFirstCard(page);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const after = await stored();
    // The two text blocks the paywall stood between are one again.
    expect(after.blocks.map((b) => b.type)).toEqual(['rich-text']);
    expect(after.access.teaser).toBe('lead');
    await expectNoAxeViolations(page);
  });

  test('typing in an empty article saves and reopens with stable block identity', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
      slug: `empty-writer-${Date.now()}`,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: 'Leeg artikel' },
        blocks: [],
      },
    });
    const route = `/admin/probe/content/${item.id}/write`;
    await login(page, `/admin/probe/content/${item.id}`);
    await page.goto(route);
    const writing = page.locator('.writing-surface .ProseMirror');
    await expect(writing).toBeVisible();
    await writing.click();
    await page.keyboard.type('Eerste tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const id = await writing.locator('[data-mycel-prose]').getAttribute('data-block-id');
    expect(id).toBeTruthy();
    await page.reload();
    await expect(writing).toContainText('Eerste tekst');
    await expect(writing.locator('[data-mycel-prose]')).toHaveAttribute('data-block-id', id!);
    await writing.locator('p').first().fill('Tweede tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.reload();
    await expect(writing).toContainText('Tweede tekst');
    await expect(writing.locator('[data-mycel-prose]')).toHaveAttribute('data-block-id', id!);
  });

  test('writer toolbar wraps whole actions at 320 CSS px and 200% text', async ({
    browser,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    // Chromium's context locale owns Accept-Language too; changing only the request header
    // left both screenshots in Dutch. Use real locale contexts and assert the rendered language.
    for (const locale of ['nl-NL', 'en-GB']) {
      const context = await browser.newContext({ locale, viewport: NARROW });
      try {
        const page = await context.newPage();
        await login(page, edit);
        await expect(page.locator('html')).toHaveAttribute('lang', locale.slice(0, 2));
        await expect(page.locator('.writing-actions').first()).toBeVisible();
        await setTextSize(page, '200%');
        await layoutGate(page, `writer actions ${locale}`, '.writing-actions');
        const screenshot = test.info().outputPath(`integrated-editor-${locale}-320-200.png`);
        await page.screenshot({ path: screenshot, fullPage: true });
        await test.info().attach(`integrated-editor-${locale}-320-200`, {
          path: screenshot,
          contentType: 'image/png',
        });
      } finally {
        await context.close();
      }
    }
  });

  test('pasted text keeps its paragraphs and marks, and no stray empty ones', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    await login(page, await article(request));
    const writing = page.locator('.writing-surface .ProseMirror');
    await writing.locator('p').first().click();
    const before = await writing.locator('p').count();
    await writing.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        'text/html',
        '<p>Eerste <strong>alinea</strong>.</p>\n<script>window.pasted = 1</script>\n<p>Tweede alinea.</p>\n'
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
      );
    });
    await expect(writing.locator('strong', { hasText: 'alinea' })).toBeVisible();
    await expect(writing.locator('p', { hasText: 'Tweede alinea.' })).toHaveCount(1);
    expect(await writing.locator('p').count()).toBeLessThanOrEqual(before + 2);
    await expect(writing.locator('p:empty, p:has(> br:only-child)')).toHaveCount(0);
    expect(await page.evaluate(() => 'pasted' in window)).toBe(false);
  });

  test('pasted blockquote becomes a structured quote card after attribution', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    await login(page, edit);
    const writing = page.locator('.writing-surface .ProseMirror');
    await writing.click();
    await writing.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/html', '<blockquote><p>Een stem uit de buurt.</p></blockquote>');
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
      );
    });
    await expect(page.getByRole('heading', { name: 'Geplakt citaat' })).toBeVisible();
    await page.getByLabel('Naam voor bronvermelding').fill('Sam');
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    await expect(page.locator('.writing-surface .ui-block-card-title')).toContainText(
      /Quote|Citaat/
    );
  });

  // ADR 026 in the writer: a colleague's title merges with my text; the same text both changed
  // asks once, the writer keeps mine, and the next save stands instead of refusing a block.
  test('the writer merges a colleague’s save and asks only about the text both changed', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    const get = () => callApi(request, 'content.item.get', { itemId });
    const colleague = async (change: (d: any) => any) => {
      const { revision } = await get();
      await callApi(request, 'content.item.update', {
        itemId,
        baseRevisionId: revision.id,
        document: change(revision.document),
      });
    };
    await login(page, edit);
    const prose = page.locator('.writing-surface .editor-prose p').first();
    await expect(page.locator('.writing-surface .ProseMirror').first()).toBeVisible();
    await colleague((d) => ({ ...d, title: { ...d.title, nl: 'Kop van collega' } }));
    await prose.fill('Mijn nieuwe tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved&merged=[0-9a-f-]{36}/);
    const merged = (await get()).revision.document;
    expect(merged.title.nl).toBe('Kop van collega');
    expect(JSON.stringify(merged.blocks[0].props.content.nl)).toContain('Mijn nieuwe tekst');

    await colleague((d) => {
      const content = structuredClone(d.blocks[0].props.content);
      content.nl.content[0].content[0].text = 'Tekst van collega';
      return { ...d, blocks: [{ ...d.blocks[0], props: { content } }, ...d.blocks.slice(1)] };
    });
    await prose.fill('Weer mijn tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Iemand anders heeft dit item intussen opgeslagen');
    await expect(alert.getByRole('radio')).toHaveCount(2);
    await expect(alert.getByRole('group', { name: 'Blok 1 (Tekst) (nl)' })).toBeVisible();
    await expect(page.locator('.writing-surface .ProseMirror').first()).toContainText(
      'Weer mijn tekst'
    );
    expect(JSON.stringify((await get()).revision.document.blocks[0])).toContain(
      'Tekst van collega'
    );
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/\?saved/);
    expect(JSON.stringify((await get()).revision.document.blocks[0])).toContain('Weer mijn tekst');
  });

  test('pasted plain text is read as text written elsewhere', async ({ page, request }) => {
    onlyA11y();
    requireApi();
    await login(page, await article(request));
    const writing = page.locator('.writing-surface .ProseMirror');
    const paste = (text: string) =>
      writing.evaluate((element, source) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData('text/plain', source);
        element.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
        );
      }, text);
    await writing.locator('p').first().click();
    // The characters stay what they are: no toggle swallows them.
    await paste('snake_case_naam en **open');
    await expect(writing.locator('p', { hasText: 'snake_case_naam en **open' })).toHaveCount(1);
    // And what is recognised takes the same route as pasted HTML.
    await paste('# Kop van elders');
    await expect(writing.getByRole('heading', { name: 'Kop van elders' })).toBeVisible();
    await paste('> Een stem uit de buurt.');
    await expect(page.getByRole('heading', { name: 'Geplakt citaat' })).toBeVisible();
  });

  // The axe floor is WCAG only and heading-order is a best practice, so Lighthouse alone saw this
  // (#162): the h2s of the prose come between the cards, and a card's title follows them.
  test('the outline of a written article skips no level, in either locale (#162)', async ({
    page,
    request,
  }) => {
    onlyA11y('axe injects a script');
    requireApi();
    const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
      type: 'article',
      slug: 'quality-article-v3',
    });
    const edit = `/admin/probe/content/${items[0]!.id}`;
    await login(page, edit);
    for (const width of [412, 1350]) {
      await page.setViewportSize({ width, height: 900 });
      for (const locale of ['nl', 'en']) {
        await page.goto(`${edit}?locale=${locale}`);
        await expect(page.locator('.writing-surface h2').first()).toBeAttached();
        expect(await headingOrderProblems(page), `${width} ${locale}`).toEqual([]);
      }
    }
  });

  for (const type of ['page', 'article'] as const)
    test(`a ${type} image description preserves other languages and explicitly saves decorative`, async ({
      page,
      request,
    }) => {
      requireApi();
      const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
        type: 'article',
        slug: 'quality-article-v3',
      });
      const { revision: source } = await callApi(request, 'content.item.get', {
        itemId: items[0]!.id,
      });
      const mediaId = source.document.blocks.find((b: { type: string }) => b.type === 'image').props
        .mediaId;
      const blockId = randomUUID();
      const { item } = await callApi(request, 'content.item.create', {
        slug: `image-description-${randomUUID()}`,
        document: {
          type,
          defaultLocale: 'nl',
          locales: ['nl', 'en'],
          title: { nl: 'Beeldbeschrijving', en: 'Image description' },
          blocks: [
            {
              id: blockId,
              type: 'image',
              version: 1,
              props: { mediaId, decorative: false, alt: { nl: 'Een boom.', en: 'A tree.' } },
            },
          ],
        },
      });
      const edit = `/admin/probe/content/${item.id}`;
      const stored = async () => {
        const { revision } = await callApi(request, 'content.item.get', { itemId: item.id });
        return revision.document.blocks[0].props;
      };
      const email = `image-alt-${randomUUID()}@probe.test`;
      const member = await withInvoker(async (invoker) =>
        invoker.run(useCases.inviteMember, systemPrincipal(await tenantId(), 'e2e'), {
          email,
          capabilities: ['tenant:admin'],
        })
      );
      const languageOf = (uiLocale: 'nl' | 'en') =>
        asOwner((owner) =>
          owner
            .updateTable('operators')
            .set({ ui_locale: uiLocale })
            .where('id', '=', member.operatorId)
            .execute()
        );
      await languageOf('nl');
      await login(page, `${edit}?locale=nl`, email);
      await editorReady(page);
      // Articles keep the native block form beside the enhanced writer.
      const description = page.locator('form#item-edit [data-block-alt]').first();
      const summary = description.locator('summary');
      const field = description.locator('textarea, input[type="text"]').first();
      const open = async () => {
        const block = description.locator('xpath=ancestor::details[contains(@class,"block")][1]');
        if ((await block.count()) && (await block.getAttribute('open')) === null)
          await block.locator(':scope > summary').click();
        if ((await description.getAttribute('open')) === null) await summary.click();
      };
      const save = async () => {
        await reloadsEditor(page, () =>
          page.getByRole('button', { name: 'Opslaan', exact: true }).click()
        );
        await expect(page).toHaveURL(/saved/);
      };
      await open();
      await expect(field).toHaveValue('Een boom.');
      await save();
      expect(await stored()).toMatchObject({
        decorative: false,
        alt: { nl: 'Een boom.', en: 'A tree.' },
      });
      await open();
      await field.fill('');
      await save();
      expect(await stored()).toMatchObject({ decorative: false, alt: { en: 'A tree.' } });
      await open();
      await expect(summary).toContainText('Beschrijving ontbreekt in het Nederlands', {
        useInnerText: true,
      });
      await openPublication(page);
      await page
        .locator('#publication-nl')
        .getByRole('button', { name: 'Publiceren', exact: true })
        .click();
      await expect(description).toHaveAttribute('open');
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await closePublication(page);
      await description.locator('input[type="checkbox"]').check();
      await save();
      expect(await stored()).toMatchObject({ decorative: true, alt: null });
      await open();
      await expect(description.locator('input[type="checkbox"]')).toHaveCount(0);
      await field.fill('Nieuwe beschrijving.');
      await save();
      expect(await stored()).toMatchObject({
        decorative: false,
        alt: { nl: 'Nieuwe beschrijving.' },
      });
      await open();
      await field.fill('');
      await save();
      expect(await stored()).toMatchObject({ decorative: true, alt: null });
      for (const language of ['nl', 'en'] as const) {
        await languageOf(language);
        await page.context().setExtraHTTPHeaders({
          'x-forwarded-proto': 'http',
          'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
          'accept-language': language,
        });
        await page.goto(`${edit}?locale=${language}`);
        await editorReady(page);
        await open();
        await expect(summary).toContainText(language === 'nl' ? 'Decoratief' : 'Decorative', {
          useInnerText: true,
        });
        await page.setViewportSize(NARROW);
        await setTextSize(page, '200%');
        await layoutGate(page, `${type} image description ${language}`, 'form#item-edit');
        if (isA11y()) await expectNoAxeViolations(page);
        const screenshot = test
          .info()
          .outputPath(`image-description-${type}-${language}-320-200.png`);
        await description.screenshot({ path: screenshot });
        await test.info().attach(`${type} image description ${language}, 320px 200%`, {
          path: screenshot,
          contentType: 'image/png',
        });
        await setTextSize(page, '100%');
        await page.setViewportSize({ width: 1280, height: 900 });
      }
    });

  test('pasted image requires media and can explicitly save without a description', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    // From the corpus article, which no spec edits: content-blocks edits the seeded block page.
    const { items } = await callApi<{ items: { id: string }[] }>(request, 'content.item.list', {
      type: 'article',
      slug: 'quality-article-v3',
    });
    const { revision } = await callApi<{
      revision: { document: { blocks: { type: string; props: { mediaId?: string } }[] } };
    }>(request, 'content.item.get', { itemId: items[0]!.id });
    const mediaId = revision.document.blocks.find((block) => block.type === 'image')?.props.mediaId;
    expect(mediaId).toBeTruthy();
    const edit = await article(request);
    await login(page, edit);
    const writing = page.locator('.writing-surface .ProseMirror');
    await writing.click();
    await writing.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        'text/html',
        '<p><img src="https://example.org/photo.jpg" alt="Een boom"></p>'
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
      );
    });
    await expect(page.getByRole('heading', { name: 'Geplakte afbeelding' })).toBeVisible();
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'writer actions', '.writing-actions');
    await expect(page.getByRole('alert')).toContainText('Vul de velden van de geplakte kaarten in');
    // The card's image comes from the shared media picker, not a typed id (brief media-picker).
    // The grid holds the newest hundred; this spec's other tests upload more, so search by name.
    const { filename } = await callApi<{ filename: string }>(request, 'media.get', { id: mediaId });
    await page.locator('.writing .pending').getByRole('button', { name: 'Beeld kiezen' }).click();
    const picker = page.getByRole('dialog', { name: 'Afbeelding' });
    await picker.getByLabel('Zoeken op naam of bijschrift').fill(filename);
    // A click, not check(): the hydrated picker then renders the choice as its own radio of the
    // same value, which unchecks the script's search result.
    await picker.locator(`input[type="radio"][value="${mediaId}"]`).click();
    await expect(page.locator('.writing .pending [data-picker-name]').first()).toHaveText(filename);
    await picker.getByRole('button', { name: 'Klaar' }).click();
    await expect(page.getByRole('button', { name: 'Vervangen' })).toBeVisible();
    const description = page.locator('.writing .pending [data-block-alt]');
    if ((await description.getAttribute('open')) === null)
      await description.locator('summary').click();
    await expect(description.locator('textarea')).toHaveValue('Een boom');
    await description.locator('textarea').fill('');
    await expect(description.locator('summary')).toContainText(
      'Zonder beschrijving wordt dit beeld decoratief.',
      { useInnerText: true }
    );
    await layoutGate(page, 'pasted image description', '.writing .pending');
    await expectNoAxeViolations(page);
    const screenshot = test.info().outputPath('pasted-image-description-320-200.png');
    await page.locator('.writing .pending').screenshot({ path: screenshot });
    await test.info().attach('pasted image description, 320px 200%', {
      path: screenshot,
      contentType: 'image/png',
    });
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
    const { revision: saved } = await callApi(request, 'content.item.get', {
      itemId: edit.split('/').at(-1),
    });
    expect(
      saved.document.blocks.find((b: { type: string }) => b.type === 'image').props
    ).toMatchObject({ decorative: true, alt: null });
    await expect(page.locator('.writing-surface .ui-block-card-title')).toContainText(
      /Image|Afbeelding/
    );
  });

  test('TipTap saves headings, lists, links and notes without changing stored structure', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    const { revision } = await callApi<{ revision: { id: string; document: any } }>(
      request,
      'content.item.get',
      { itemId }
    );
    const rich = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Tussenkop' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Vet', marks: [{ type: 'bold' }] },
            {
              type: 'text',
              text: ' bron',
              marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
            },
            {
              type: 'text',
              text: ' noot',
              marks: [{ type: 'footnote_reference', attrs: { text: 'Bron 1' } }],
            },
          ],
        },
        {
          type: 'bullet_list',
          content: [
            {
              type: 'list_item',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Punt' }] }],
            },
          ],
        },
        {
          type: 'ordered_list',
          attrs: { start: 3 },
          content: [
            {
              type: 'list_item',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Derde', marks: [{ type: 'bold' }] },
                    { type: 'text', text: ' punt' },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'ordered_list',
          attrs: { start: 1 },
          content: [
            {
              type: 'list_item',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Eerste', marks: [{ type: 'bold' }] },
                    { type: 'text', text: ' punt' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        blocks: [
          {
            ...revision.document.blocks[0],
            props: { content: { nl: rich, en: revision.document.blocks[0].props.content.en } },
          },
        ],
      },
    });
    await login(page, edit);

    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision: latest } = await callApi<{ revision: { document: any } }>(
      request,
      'content.item.get',
      { itemId }
    );
    expect(latest.document.blocks[0].id).toBe(revision.document.blocks[0].id);
    expect(latest.document.blocks[0].props.content.nl).toEqual(rich);
    expect(latest.document.blocks[0].props.content.en).toEqual(
      revision.document.blocks[0].props.content.en
    );
    const listItem = page.locator('.writing-surface .ProseMirror ol li p').last();
    await listItem.click();
    await page.keyboard.press('End');
    await page.keyboard.type(' aangevuld');
    await expect(listItem).toContainText('Eerste punt aangevuld');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await expect
      .poll(async () => {
        const { revision: current } = await callApi<{ revision: { document: any } }>(
          request,
          'content.item.get',
          { itemId }
        );
        return current.document.blocks[0].props.content.nl.content[4].content[0].content[0].content
          .map((part: { text: string }) => part.text)
          .join('');
      })
      .toBe('Eerste punt aangevuld');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision: afterEdit } = await callApi<{ revision: { document: any } }>(
      request,
      'content.item.get',
      { itemId }
    );
    expect(afterEdit.document.blocks[0].id).toBe(revision.document.blocks[0].id);
    expect(afterEdit.document.blocks[0].props.content.nl).toEqual({
      ...rich,
      content: rich.content.map((node) =>
        node.type === 'ordered_list' && node.attrs?.start === 1
          ? {
              ...node,
              content: [
                {
                  type: 'list_item',
                  content: [
                    {
                      type: 'paragraph',
                      content: [
                        { type: 'text', text: 'Eerste', marks: [{ type: 'bold' }] },
                        { type: 'text', text: ' punt aangevuld' },
                      ],
                    },
                  ],
                },
              ],
            }
          : node
      ),
    });
    expect(afterEdit.document.blocks[0].props.content.en).toEqual(
      revision.document.blocks[0].props.content.en
    );
  });

  // The action row is typed as the site shows it. Adding, moving and removing a card are
  // submits that show the form again with nothing saved, so the no-JS project walks the same path.
  // Started from the empty form, which the seeded examples never reach.
  test('a row of cards is added to, rearranged and saved, from two to four and back', async ({
    page,
  }) => {
    await login(page, '/admin/probe');
    await blockPage(page, 'cards');
    await editorReady(page);
    await page
      .locator('[data-block-picker]')
      .last()
      .getByRole('button', { name: 'Actierij', exact: true })
      .click();
    let row = page.locator('#block-new');
    await expect(row.getByRole('heading')).toHaveText('Nieuw blok: Actierij');
    await editorReady(page);
    const titles = () => row.getByLabel('Titel', { exact: true });
    const typed = () =>
      expect.poll(() => titles().evaluateAll((f) => f.map((x) => (x as HTMLInputElement).value)));
    await expect(titles()).toHaveCount(2);
    await expect(row.getByText('2 van maximaal 4 kaarten')).toBeVisible();
    await expect(row.getByRole('radio', { name: 'Geen' })).toBeChecked();

    // One card typed, then a third added: nothing is saved, nothing refused, the words stay.
    await titles().first().fill('Eerste kaart');
    await row.getByRole('button', { name: 'Kaart toevoegen' }).click();
    row = page.locator('#block-new');
    await expect(titles()).toHaveCount(3);
    await expect(titles().first()).toHaveValue('Eerste kaart');
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Saved with one card typed: refused by name, the typed card and the empty rows stay.
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    const refusal = page.getByRole('listitem').filter({ hasText: 'vul minstens twee kaarten in' });
    await expect(refusal).toHaveText('Kaarten: vul minstens twee kaarten in');
    row = page.locator('#block-new');
    await expect(titles()).toHaveCount(3);
    await expect(titles().first()).toHaveValue('Eerste kaart');
    await titles().nth(1).fill('Tweede kaart');
    await titles().nth(2).fill('Derde kaart');
    await row.getByRole('radio', { name: 'Balk' }).check();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');

    // Stored: no spare row, the count, and the fourth card is the last one the row takes.
    row = await block(page, 1);
    await typed().toEqual(['Eerste kaart', 'Tweede kaart', 'Derde kaart']);
    await expect(row.getByRole('radio', { name: 'Balk' })).toBeChecked();
    await row.getByRole('button', { name: 'Kaart toevoegen' }).click();
    row = card(page, 1);
    await expect(titles()).toHaveCount(4);
    await expect(row.getByRole('button', { name: 'Kaart toevoegen' })).toHaveCount(0);
    await expect(row.getByText('4 van maximaal 4 kaarten')).toBeVisible();

    // Moved and removed through each card's "More"; at two cards removing is not offered.
    const menu = async (n: number) => {
      const more = row
        .locator('.ui-row-card')
        .nth(n - 1)
        .locator('details.ui-row-more');
      if ((await more.getAttribute('open')) === null)
        await more.getByLabel(`Meer acties voor kaart ${n}`).click();
      return more;
    };
    await (await menu(1)).getByRole('button', { name: 'Later in de rij' }).click();
    row = card(page, 1);
    await typed().toEqual(['Tweede kaart', 'Eerste kaart', 'Derde kaart', '']);
    await (await menu(3)).getByRole('button', { name: 'Verwijderen' }).click();
    row = card(page, 1);
    await (await menu(3)).getByRole('button', { name: 'Verwijderen' }).click();
    row = card(page, 1);
    await typed().toEqual(['Tweede kaart', 'Eerste kaart']);
    await expect((await menu(1)).getByRole('button', { name: 'Verwijderen' })).toHaveCount(0);
    await expect(row.getByText('Een rij heeft minstens 2 kaarten.').first()).toBeVisible();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    row = await block(page, 1);
    await typed().toEqual(['Tweede kaart', 'Eerste kaart']);

    // The UI gate on the open row (skill ui-action-layout): one column, every label whole.
    await page.setViewportSize(NARROW);
    await expect((await menu(2)).getByRole('button', { name: 'Eerder in de rij' })).toBeVisible();
    for (const size of ['100%', '200%']) {
      await setTextSize(page, size);
      await layoutGate(page, `action row at ${size}`, 'section.ui-block-card');
    }
    if (isA11y()) await expectNoAxeViolations(page, { label: 'action row' });
  });

  // A button's target (TargetPicker): with JavaScript one search finds pages and articles together or
  // takes an address; without it the select and the address field are the path. Both write the
  // same two controls, so the stored targets are the same in both projects.
  test('a card button links to a page found by search, or to an address', async ({ page }) => {
    const probe = await tenantId();
    const word = `Doelpagina ${randomUUID().slice(0, 8)}`;
    const target = await withInvoker((invoker) =>
      invoker.run(useCases.createItem, systemPrincipal(probe, 'e2e'), {
        slug: `doel-${randomUUID()}`,
        document: {
          type: 'page',
          defaultLocale: 'nl',
          locales: ['nl'],
          title: { nl: word },
          blocks: [],
        },
      })
    );
    await login(page, '/admin/probe');
    const edit = await blockPage(page, 'target');
    await editorReady(page);
    await page
      .locator('[data-block-picker]')
      .last()
      .getByRole('button', { name: 'Actierij', exact: true })
      .click();
    const row = page.locator('#block-new');
    await editorReady(page);
    const titles = row.getByLabel('Titel', { exact: true });
    await titles.nth(0).fill('Naar de pagina');
    await titles.nth(1).fill('Naar buiten');
    const labels = row.getByLabel('Tekst op de knop', { exact: true });
    await labels.nth(0).fill('Lees');
    await labels.nth(1).fill('Doe mee');
    const address = 'https://example.org/doe-mee';
    const label = `${word} (/${target.item.slug})`;
    if (isA11y()) {
      await expect(row.locator('[data-target-native]').first()).toBeHidden();
      const search = row.getByRole('combobox', { name: 'Linkt naar' });
      await search.nth(0).fill(word.toLowerCase().slice(0, 12));
      await expect(row.getByRole('option', { name: label })).toBeVisible();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(search.nth(0)).toHaveValue(label);
      await search.nth(1).fill(address);
      await expect(row.getByRole('option', { name: `Adres gebruiken: ${address}` })).toBeVisible();
      await expectNoAxeViolations(page, { label: 'target search open' });
      await page.setViewportSize(NARROW);
      for (const size of ['100%', '200%']) {
        await setTextSize(page, size);
        await layoutGate(page, `target search at ${size}`, '#block-new');
      }
      await setTextSize(page, '100%');
      await search.nth(1).press('Tab');
      await expect(search.nth(1)).toHaveValue(address);
      // An older item outside the select's hundred is found by the route behind the search.
      const found = await page.request.get(
        `/admin/probe/content/choices?q=${encodeURIComponent(word)}&locale=nl`
      );
      expect((await found.json()).items).toEqual([{ id: target.item.id, label }]);
    } else {
      // A select is a combobox too; the search beside it is hidden without JavaScript.
      const targets = row.getByRole('combobox', { name: 'Linkt naar' });
      await targets.nth(0).selectOption({ label });
      await targets.nth(1).selectOption({ label: 'Het adres hieronder' });
      await row.getByLabel('Adres (URL)', { exact: true }).nth(1).fill(address);
    }
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Opgeslagen als nieuwe revisie');
    const itemId = edit.split('/').at(-1)!;
    const { revision } = await withInvoker((invoker) =>
      invoker.run(useCases.getItem, systemPrincipal(probe, 'e2e'), { itemId })
    );
    const cards = (revision.document.blocks[0]!.props as { cards: { actions: unknown[] }[] }).cards;
    expect(cards.map((c) => (c.actions[0] as { target: unknown }).target)).toEqual([
      { kind: 'item', itemId: target.item.id },
      { kind: 'url', url: address },
    ]);
    if (isA11y()) {
      await (await block(page, 1)).getByRole('combobox', { name: 'Linkt naar' }).first().focus();
      await expect(
        (await block(page, 1)).getByRole('combobox', { name: 'Linkt naar' }).first()
      ).toHaveValue(label);
    }
  });

  // A writer without content:publish offers a locale for publication (decided 2026-11-06): the
  // offer saves the form, carries a note, reaches whoever may publish through the attention list,
  // and can be taken back. The UI gate measures the writer's card at 320 CSS px and 200 % text.
  test('a writer offers an article for publication with a note and takes the offer back', async ({
    page,
    request,
  }) => {
    const email = `offer-${test.info().project.name}-${Date.now()}@probe.test`;
    const probe = await tenantId();
    const { operatorId } = await withInvoker((invoker) =>
      invoker.run(useCases.inviteMember, systemPrincipal(probe, 'e2e'), {
        email,
        capabilities: ['content:read', 'content:write', 'media:read', 'media:write'],
      })
    );
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    const card = page.locator('#publication-nl');
    // Read as the site itself: the seed key may write but not publish, so it sees no offers.
    const offers = async () =>
      (
        await withInvoker((invoker) =>
          invoker.run(useCases.listAttention, systemPrincipal(probe, 'e2e'), {})
        )
      ).items.filter((i) => i.key === `review:${itemId}:nl`);
    try {
      await login(page, edit, email);
      await openPublication(page);
      const offer = card.getByRole('button', { name: 'Ter publicatie aanbieden' });
      await expect(offer).toBeVisible();
      await expectNoAxeViolations(page);
      if (isA11y()) {
        await page.setViewportSize(NARROW);
        await setTextSize(page, '200%');
        await layoutGate(page, 'writer publication', '#publication-panel');
        await page.screenshot({ path: test.info().outputPath('offer-320-200.png') });
        await page.setViewportSize({ width: 1280, height: 900 });
        await setTextSize(page, '100%');
      }

      await card.getByLabel('Notitie voor wie publiceert').fill('Graag vóór vrijdag');
      await offer.click();
      await expect(page).toHaveURL(`${edit}?done=offer&locale=nl`);
      await expect(
        page.getByRole('status').filter({ hasText: 'Ter publicatie aangeboden in nl.' })
      ).toContainText('Ter publicatie aangeboden in nl.');
      await openPublication(page);
      await expect(card).toContainText(/Ter publicatie aangeboden op \d{4}-\d{2}-\d{2}/);
      await expect(card).toContainText('Notitie: Graag vóór vrijdag');
      await expectNoAxeViolations(page);
      expect(await offers()).toEqual([expect.objectContaining({ detail: 'Een artikel' })]);

      await card.getByRole('button', { name: 'Aanbieding intrekken' }).click();
      await expect(page).toHaveURL(`${edit}?done=withdrawOffer&locale=nl`);
      await expect(
        page.getByRole('status').filter({ hasText: 'Aanbieding ingetrokken in nl.' })
      ).toContainText('Aanbieding ingetrokken in nl.');
      await openPublication(page);
      await expect(offer).toBeVisible();
      await closePublication(page);
      expect(await offers()).toEqual([]);
    } finally {
      await withInvoker((invoker) =>
        invoker.run(useCases.removeMember, systemPrincipal(probe, 'e2e'), { operatorId })
      );
    }
  });

  // The formatting bar is the complete way to every command and shows the state of the
  // text at the cursor; the selection bar repeats the marks at the words for a pointer.
  test('formatting bar and selection bar write marks, a heading, a list and code', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    await login(page, edit);
    const writing = page.locator('.writing-surface .ProseMirror');
    const bar = page.getByRole('toolbar', { name: 'Tekstopmaak' });
    const tool = (name: string) => bar.getByRole('button', { name, exact: true });
    const style = bar.getByRole('combobox', { name: 'Tekstsoort' });
    await expect(tool('Link')).toBeDisabled();
    await expect(tool('Ongedaan maken')).toBeDisabled();
    await writing.locator('p').first().selectText();
    await tool('Vet').click();
    await expect(tool('Vet')).toHaveAttribute('aria-pressed', 'true');
    const selection = page.getByRole('group', { name: 'Opmaak voor de selectie' });
    await expect(selection.getByRole('button', { name: 'Vet' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await selection.getByRole('button', { name: 'Cursief' }).click();
    await page.screenshot({ path: test.info().outputPath('formatting-selection-1280.png') });
    await expect(writing.locator('strong em, em strong')).toHaveText('Oude tekst');
    // The bar stands clear of the words it belongs to.
    const words = (await writing.locator('p').first().boundingBox())!;
    const over = (await selection.boundingBox())!;
    expect(over.y + over.height <= words.y || over.y >= words.y + words.height).toBe(true);
    await page.keyboard.press('ArrowRight');
    await expect(selection).toBeHidden();
    await page.keyboard.press('Enter');
    await tool('Vet').click();
    await tool('Cursief').click();
    await expect(tool('Vet')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('Tussenkopje');
    await style.selectOption({ label: 'Tussenkop' });
    await expect(writing.locator('h1')).toHaveText('Tussenkopje');
    // A heading never skips a level: under the first heading only its own level and the next.
    await expect(style.getByRole('option', { name: 'Kleine kop' })).toBeDisabled();
    await page.keyboard.press('Enter');
    await expect(style).toHaveValue('0');
    await expect(style.getByRole('option', { name: 'Subkop' })).toBeEnabled();
    await page.keyboard.type('eerste punt');
    await tool('Opsomming').click();
    await expect(tool('Opsomming')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect(tool('Opsomming')).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.type('npm run dev');
    await writing.locator('p').last().selectText();
    await tool('Code').click();
    await expect(writing.locator('code')).toHaveText('npm run dev');
    // One tab stop with arrow keys; the name and shortcut show on keyboard focus too.
    await tool('Vet').focus();
    await page.keyboard.press('ArrowRight');
    await expect(tool('Cursief')).toBeFocused();
    await expect(bar.locator(':scope > .format-tip')).toHaveText(/^Cursief \((Ctrl\+|⌘)I\)$/);
    await page.screenshot({ path: test.info().outputPath('formatting-bar-1280.png') });
    await expect(tool('Ongedaan maken')).toBeEnabled();
    await expectNoAxeViolations(page);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision } = await callApi(request, 'content.item.get', {
      itemId: edit.split('/').at(-1)!,
    });
    const [first, heading, list, code] = revision.document.blocks[0].props.content.nl.content;
    expect(first.content[0].marks.map((m: { type: string }) => m.type).sort()).toEqual([
      'bold',
      'italic',
    ]);
    expect(heading).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    expect(list.type).toBe('bullet_list');
    expect(code.content[0].marks).toEqual([{ type: 'code' }]);
  });

  test('the link field marks the words, refuses an unsafe address and gives the selection back', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    const edit = await article(request);
    await login(page, edit);
    const writing = page.locator('.writing-surface .ProseMirror');
    const bar = page.getByRole('toolbar', { name: 'Tekstopmaak' });
    const field = page.getByRole('group', { name: 'Link', exact: true });
    const address = field.getByLabel('Linkadres');
    // ProseMirror reads a selection a moment later, and right after typing it writes its own
    // back over one made here; the enabled button says the selection is the editor's.
    const select = () =>
      expect(async () => {
        await writing.locator('p').first().selectText();
        await expect(bar.getByRole('button', { name: 'Link', exact: true })).toBeEnabled({
          timeout: 1000,
        });
      }).toPass();
    await select();
    await page.keyboard.press('Control+k');
    await expect(address).toBeFocused();
    await expect(writing.locator('.editor-pending-range')).toHaveText('Oude tekst');
    await address.fill('javascript:alert(1)');
    await page.keyboard.press('Enter');
    await expect(
      field.getByText('Gebruik een http-, https-, mailto- of sitepadlink.')
    ).toBeVisible();
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await address.fill('https://example.org/');
    await page.keyboard.press('Enter');
    await expect(field).toBeHidden();
    await expect(writing.locator('a[href="https://example.org/"]')).toHaveText('Oude tekst');
    await expect(writing).toBeFocused();
    // With the cursor in a link the button edits the whole link, and can remove it.
    await writing.locator('a').click();
    await bar.getByRole('button', { name: 'Link', exact: true }).click();
    await expect(address).toHaveValue('https://example.org/');
    await page.keyboard.press('Escape');
    await expect(field).toBeHidden();
    await bar.getByRole('button', { name: 'Link', exact: true }).click();
    await field.getByRole('button', { name: 'Link verwijderen' }).click();
    await expect(writing.locator('a')).toHaveCount(0);
    // Escape leaves the text as it was, the same words selected: typing replaces them.
    await select();
    await page.keyboard.press('Control+k');
    await expect(address).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.type('Nieuwe tekst');
    await expect(writing.locator('p').first()).toHaveText('Nieuwe tekst');
    await expect(page).toHaveURL(new RegExp(`${edit}$`));
    // The open field with its refusal, at the narrowest width and the largest text.
    await select();
    await page.keyboard.press('Control+k');
    await address.fill('ftp://example.org');
    await page.keyboard.press('Enter');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expectNoAxeViolations(page);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'link field', '.writing');
    await page
      .locator('.writing')
      .first()
      .screenshot({ path: test.info().outputPath('link-field-320-200.png') });
  });

  test('the formatting bar stays in view in a long text where the document bar does', async ({
    page,
    request,
  }) => {
    onlyA11y();
    requireApi();
    await page.setViewportSize({ width: 1280, height: 720 });
    await login(page, await article(request));
    const writing = page.locator('.writing-surface .ProseMirror');
    const bar = page.getByRole('toolbar', { name: 'Tekstopmaak' });
    await writing.locator('p').first().click();
    for (let line = 0; line < 60; line++) await page.keyboard.press('Enter');
    await page.keyboard.type('Laatste regel');
    const top = async () => (await bar.boundingBox())!.y;
    const documentBar = (await page.locator('.ui-item-bar').boundingBox())!;
    expect(Math.abs((await top()) - (documentBar.y + documentBar.height))).toBeLessThan(12);
    // The cursor is not under the bars that stay.
    const cursor = (await writing.locator('p').last().boundingBox())!;
    expect(cursor.y).toBeGreaterThan((await top()) + (await bar.boundingBox())!.height);
    await page.screenshot({ path: test.info().outputPath('formatting-sticky-1280.png') });
    // Narrow, both bars scroll along: together they would cover the text.
    await page.setViewportSize(NARROW);
    await writing.locator('p').last().scrollIntoViewIfNeeded();
    expect(await top()).toBeLessThan(0);
    await layoutGate(page, 'long text', '.writing-actions');
    await page.locator('.writing-actions').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath('formatting-bar-320.png') });
  });
});

// What asks for attention (brief admin-attention-notifications): an offer for
// publication and a task out of attempts reach an administrator through the bell, the dot on
// Manage, the dashboard card and the notifications page; reading the page puts the bell out (a
// button without JavaScript, by itself with it), and both leave the list once solved, without
// anyone marking them. A fresh member, so its read moment is its own; rows are found by their
// key, since other specs make stuck tasks of their own at the same time.
test.describe('attention', () => {
  test.use({ locale: 'nl-NL' });

  test('an offer and a failed task reach the bell, are read, and leave once solved', async ({
    page,
    request,
  }) => {
    const run = `${test.info().project.name}-${Date.now()}`;
    const probe = await tenantId();
    const site = systemPrincipal(probe, 'e2e');
    const { operatorId } = await withInvoker((invoker) =>
      invoker.run(useCases.inviteMember, site, {
        email: `attention-${run}@probe.test`,
        capabilities: capabilitiesFor('admin'),
      })
    );
    const itemId = (await article(request)).split('/').at(-1)!;
    const offer = { itemId, locale: 'nl' };
    await withInvoker((invoker) => invoker.run(useCases.requestContentReview, site, offer));
    const jobs = [await stuckJob(`e2e.attention.${run}`)];
    const row = (key: string) => page.locator(`li[data-attention="${key}"]`);
    const job = row(`job:${jobs[0]}`);
    const offered = row(`review:${itemId}:nl`);
    try {
      await login(page, '/admin/probe', `attention-${run}@probe.test`);
      // A first visit: everything is new, and Manage says something there asks.
      const bell = page.getByRole('link', { name: /^Meldingen \d+ nieuw$/ });
      await expect(bell).toBeVisible();
      await expect(page.locator('summary[aria-label="Beheer, vraagt aandacht"]')).toHaveCount(1);
      const card = page.getByRole('region', { name: 'Wachtend werk' });
      await expect(card.getByRole('link', { name: /^Alle meldingen \(\d+\)$/ })).toBeVisible();
      await expectNoAxeViolations(page);
      if (isA11y()) {
        // In the rail the label hides; the count stays on the bell's corner, Manage's dot too.
        await page.locator('[data-nav-toggle]').click();
        await expect(bell.locator('.ui-attention-count')).toBeVisible();
        await page.screenshot({ path: test.info().outputPath('attention-rail.png') });
        await page.locator('[data-nav-toggle]').click();
      }

      await bell.click();
      await expect(page).toHaveURL(/\/admin\/probe\/meldingen$/);
      await expect(page.getByRole('heading', { level: 1, name: 'Meldingen' })).toBeVisible();
      await expect(page.locator('a[aria-current="page"].admin-bell')).toHaveCount(1);
      await expect(job).toContainText('Andere taak mislukte bij elke poging');
      await expect(job).toContainText('Nieuw');
      await expect(job.getByRole('link')).toHaveAttribute('href', '/admin/probe/status#jobs');
      await expect(offered).toContainText('ter publicatie aangeboden');
      await expect(offered).toContainText('Nieuw');
      await expect(offered.getByRole('link')).toHaveAttribute(
        'href',
        `/admin/probe/content/${itemId}?locale=nl`
      );
      await expect(page.locator('#attention-review')).toContainText('Ter publicatie aangeboden');
      await expectNoAxeViolations(page);
      if (isA11y()) {
        await page.setViewportSize(NARROW);
        await setTextSize(page, '200%');
        await layoutGate(page, 'notifications', 'main');
        await page.screenshot({
          path: test.info().outputPath('attention-320-200.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1280, height: 900 });
        await setTextSize(page, '100%');
        // With JavaScript the open page is the read page: the form posts itself and goes.
        await expect(page.locator('form[data-attention-seen]')).toHaveCount(0);
        await page.reload();
      } else {
        await page.getByRole('button', { name: 'Markeer als gelezen' }).click();
        await expect(page.getByRole('status')).toContainText('Gemarkeerd als gelezen.');
      }
      // Read: still listed, no longer new.
      await expect(job).toBeVisible();
      await expect(job).not.toContainText('Nieuw');
      await expect(offered).not.toContainText('Nieuw');

      // Solved elsewhere, gone here: the task is finished and the offer taken back.
      await finishJobs(jobs.splice(0));
      await withInvoker((invoker) => invoker.run(useCases.withdrawContentReview, site, offer));
      await page.reload();
      await expect(job).toHaveCount(0);
      await expect(offered).toHaveCount(0);
    } finally {
      await finishJobs(jobs);
      await withInvoker((invoker) => invoker.run(useCases.removeMember, site, { operatorId }));
    }
  });
});

// ADR 026 after a save that merged: an action that pins a revision is not taken on content the
// screen never showed, and the same post twice adds a new block once. Here, not in content-admin
// with the merge itself, because that spec is at its size limit.
test.describe('after a save that merged', () => {
  test.use({
    locale: 'nl-NL',
    extraHTTPHeaders: {
      'x-forwarded-proto': 'http',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
    },
  });
  const slugFor = (what: string) =>
    `aw-${what}-${test.info().project.name}-${randomUUID()}`.toLowerCase();

  // A publication action after a save that merged would put live what the publisher
  // never saw. It is not taken: the screen comes back on the merged revision, says with whose
  // save, and the action is chosen again. With and without JavaScript.
  test('publishing from an outdated form that merged publishes nothing unseen', async ({
    page,
    request,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('held'), 'Eerste versie');
    const itemId = edit.split('/').at(-1)!;
    const item = async () => callApi(request, 'content.item.get', { itemId });
    const { revision } = await item();
    await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: { ...revision.document, lead: { nl: 'Concept van een ander' } },
    });
    await page.locator('#title\\.nl').fill('Titel van de publiceerder');
    await openPublication(page);
    const publish = () =>
      page.locator('#publication-nl').getByRole('button', { name: 'Publiceren', exact: true });
    await publish().click();
    await expect(page).toHaveURL(new RegExp(`\\?held&merged=[0-9a-f-]{36}$`));
    await expect(page.getByRole('status')).toContainText('niets gepubliceerd');
    const after = await item();
    expect(after.item.publication.find((p: { locale: string }) => p.locale === 'nl')).toMatchObject(
      { publishedRevisionId: null }
    );
    // The merged revision is what the screen shows now; publishing it is the second, seen click.
    expect(after.revision.document.lead.nl).toBe('Concept van een ander');
    await expect(page.locator('#title\\.nl')).toHaveValue('Titel van de publiceerder');
    await expectNoAxeViolations(page);
    await openPublication(page);
    await publish().click();
    await expect(page).toHaveURL(/\?done=publish/);
    const live = await item();
    expect(live.item.publication.find((p: { locale: string }) => p.locale === 'nl')).toMatchObject({
      publishedRevisionId: after.revision.id,
    });
  });

  // A form whose changes are all in the newest revision merges into exactly that revision, and
  // core writes nothing. The newest holds more than the form showed, so nothing is published.
  test('publishing changes another save already made publishes nothing unseen', async ({
    page,
    request,
  }) => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('subset'), 'Eerste versie');
    const itemId = edit.split('/').at(-1)!;
    const item = async () => callApi(request, 'content.item.get', { itemId });
    const { revision } = await item();
    const theirs = await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        title: { nl: 'Dezelfde correctie' },
        lead: { nl: 'Concept van een ander' },
      },
    });
    await page.locator('#title\\.nl').fill('Dezelfde correctie');
    await openPublication(page);
    const publish = () =>
      page.locator('#publication-nl').getByRole('button', { name: 'Publiceren', exact: true });
    await reloadsEditor(page, () => publish().click());
    await expect(page).toHaveURL(new RegExp(`\\?held&merged=${theirs.revision.id}$`));
    await expect(page.getByRole('status')).toContainText('niets gepubliceerd');
    const after = await item();
    expect(after.revision.id).toBe(theirs.revision.id);
    expect(after.item.publication.find((p: { locale: string }) => p.locale === 'nl')).toMatchObject(
      { publishedRevisionId: null }
    );
    await openPublication(page);
    await reloadsEditor(page, () => publish().click());
    await expect(page).toHaveURL(/\?done=publish/);
    const live = await item();
    expect(live.item.publication.find((p: { locale: string }) => p.locale === 'nl')).toMatchObject({
      publishedRevisionId: theirs.revision.id,
    });
  });

  // The same post twice (a double click on Save with a new block in the form) adds the
  // block once. The second post arrives after the first stood, on the base the form was opened on.
  test('the same save posted twice adds a new block once', async ({ page, request }) => {
    onlyA11y('two posts of one form are sent from the page');
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor('twice'), 'Twee keer');
    const itemId = edit.split('/').at(-1)!;
    await page.goto(`${edit}?insert=heading&place=end#block-new`);
    await page.locator('#block-new').getByLabel('Tekst', { exact: true }).fill('Eén kop');
    const statuses = await page
      .getByRole('button', { name: 'Opslaan', exact: true })
      .evaluate(async (button: HTMLButtonElement) => {
        const body = new FormData(button.form!, button);
        const out: number[] = [];
        for (const _ of [1, 2])
          out.push((await fetch(button.formAction, { method: 'POST', body })).status);
        return out;
      });
    expect(statuses).toEqual([200, 200]);
    const { revision } = await callApi(request, 'content.item.get', { itemId });
    expect(revision.document.blocks.map((b: { type: string }) => b.type)).toEqual(['heading']);
  });

  /**
   * A page with three headings, its edit screen open on that revision, then another save on it that
   * changes the second.
   */
  const threeHeadings = async (page: Page, request: APIRequestContext, what: string, at = '') => {
    await login(page, '/admin/probe');
    const edit = await newPage(page, slugFor(what), 'Herbasseren');
    const itemId = edit.split('/').at(-1)!;
    const heading = (nl: string) => ({ type: 'heading', version: 1, props: { text: { nl } } });
    const first = await callApi(request, 'content.item.get', { itemId });
    const { revision } = await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: first.revision.id,
      document: {
        ...first.revision.document,
        blocks: [heading('Eerste'), heading('Tweede'), heading('Derde')],
      },
    });
    await page.goto(`${edit}${at}`);
    await editorReady(page);
    const blocks = revision.document.blocks;
    const theirs = await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        blocks: [
          blocks[0],
          { ...blocks[1], props: { text: { nl: 'Tweede, van een ander' } } },
          blocks[2],
        ],
      },
    });
    return { edit, itemId, theirs: theirs.revision };
  };

  // ADR 027: a block action from a screen opened before another save is applied to the newest
  // revision when its block did not change, and the screen says with whose save it merged.
  test('a block action on an outdated screen is rebased and says so', async ({ page, request }) => {
    const { itemId, theirs } = await threeHeadings(page, request, 'rebase');
    await reloadsEditor(page, async () =>
      (await more(page, 1)).getByRole('button', { name: 'Verwijderen', exact: true }).click()
    );
    await expect(page).toHaveURL(new RegExp(`done=blockRemoved&.*merged=${theirs.id}`));
    await expect(page.getByRole('status').first()).toContainText(
      'Niets van wat jullie veranderden'
    );
    const { revision } = await callApi(request, 'content.item.get', { itemId });
    expect(revision.provenance).toEqual({
      merged: { baseRevisionId: expect.any(String), latestRevisionId: theirs.id },
    });
    expect(
      revision.document.blocks.map((b: { props: { text: { nl: string } } }) => b.props.text.nl)
    ).toEqual(['Tweede, van een ander', 'Derde']);
    await expectNoAxeViolations(page);
  });

  // A new block typed on an outdated screen is inserted on the newest revision, so publishing in
  // the same click would put the other save live unseen: held, as after a save that merged.
  test('publishing after a block insert that was rebased publishes nothing unseen', async ({
    page,
    request,
  }) => {
    const at = '?insert=heading&place=end#block-new';
    const { itemId, theirs } = await threeHeadings(page, request, 'rebase-held', at);
    await page.locator('#block-new').getByLabel('Tekst', { exact: true }).fill('Nieuwe kop');
    await openPublication(page);
    await reloadsEditor(page, () =>
      page
        .locator('#publication-nl')
        .getByRole('button', { name: 'Publiceren', exact: true })
        .click()
    );
    await expect(page).toHaveURL(new RegExp(`\\?held&merged=${theirs.id}$`));
    await expect(page.getByRole('status')).toContainText('niets gepubliceerd');
    const after = await callApi(request, 'content.item.get', { itemId });
    expect(after.item.publication.find((p: { locale: string }) => p.locale === 'nl')).toMatchObject(
      { publishedRevisionId: null }
    );
    expect(
      after.revision.document.blocks.map(
        (b: { props: { text: { nl: string } } }) => b.props.text.nl
      )
    ).toEqual(['Eerste', 'Tweede, van een ander', 'Derde', 'Nieuwe kop']);
  });
});

test.describe('bulk section', () => {
  test.use({ locale: 'nl-NL' });
  test('bulk section saves a draft and restores the previous section', async ({
    page,
    request,
  }) => {
    const slug = `bulk-section-${randomUUID()}`;
    const section = await callApi(request, 'content.section.create', {
      slug,
      title: { nl: 'Bulk section' },
    });
    const { item } = await callApi(request, 'content.item.create', {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl'],
        title: { nl: slug },
        blocks: [],
      },
    });
    await login(page, `/admin/probe/content?type=article&q=${slug}`);
    await page.getByLabel('Alles op deze pagina', { exact: true }).check();
    await page.getByLabel('Handeling', { exact: true }).selectOption('section');
    await page.getByLabel('Rubriek wijzigen', { exact: true }).selectOption(section.id);
    await page.getByRole('button', { name: 'Droogloop voorbereiden' }).click();
    await expect(page.getByText('Rubriek wijzigen: Bulk section', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Bevestigen en eerste item verwerken' }).click();
    const saved = await callApi(request, 'content.item.get', { itemId: item.id });
    expect(saved.revision.document.sectionId).toBe(section.id);
    expect(
      saved.item.publication.every(
        (p: { publishedRevisionId: string | null }) => !p.publishedRevisionId
      )
    ).toBe(true);
    await page.getByRole('button', { name: 'Run stoppen en eerste item herstellen' }).click();
    const restored = await callApi(request, 'content.item.get', { itemId: item.id });
    expect(restored.revision.document.sectionId).toBeNull();
    await withInvoker(async (invoker) =>
      invoker.run(useCases.publishItem, systemPrincipal(await tenantId(), 'e2e'), {
        itemId: item.id,
        revisionId: restored.revision.id,
        locale: 'nl',
      })
    );
    await page.goto(`/admin/probe/content?type=article&q=${slug}`);
    await page.getByLabel('Alles op deze pagina', { exact: true }).check();
    await page.getByLabel('Handeling', { exact: true }).selectOption('unpublish');
    await page.getByRole('button', { name: 'Droogloop voorbereiden' }).click();
    await page.getByRole('button', { name: 'Bevestigen en eerste item verwerken' }).click();
    const offline = await callApi(request, 'content.item.get', { itemId: item.id });
    expect(offline.item.publication[0].publishedRevisionId).toBeNull();
    await page.getByRole('button', { name: 'Run stoppen en eerste item herstellen' }).click();
    const live = await callApi(request, 'content.item.get', { itemId: item.id });
    expect(live.item.publication[0].publishedRevisionId).toBe(restored.revision.id);
  });
});

// The trash (ADR 030): the row asks first, a link from elsewhere refuses, and it comes back offline.
test.describe('content-trash', () => {
  test.use({ locale: 'nl-NL' });

  test('a row goes to the trash after a question, is refused while linked, and comes back', async ({
    page,
    request,
  }) => {
    requireApi();
    const word = `prul${randomUUID().slice(0, 8)}`;
    const create = async (slug: string, title: string, blocks: unknown[] = []) =>
      (
        await callApi<{ item: { id: string; latestRevisionId: string } }>(
          request,
          'content.item.create',
          {
            slug,
            document: {
              type: 'page',
              defaultLocale: 'nl',
              locales: ['nl'],
              title: { nl: title },
              blocks,
            },
          }
        )
      ).item;
    const target = await create(`doel-${word}`, `Doel ${word}`);
    const linkBlock = {
      id: 'link',
      type: 'rich-text',
      version: 1,
      props: {
        content: {
          nl: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: 'zie',
                    marks: [{ type: 'link', attrs: { itemId: target.id } }],
                  },
                ],
              },
            ],
          },
        },
      },
    };
    const source = await create(`bron-${word}`, `Bron ${word}`, [linkBlock]);
    const list = `/admin/probe/content?type=page&q=${word}&sort=title`;
    await login(page, list);
    const remove = async (id: string, title: string) => {
      const actions = page.locator(`[id="item-${id}"] .ui-row-actions.inline`);
      await page.locator(`[id="item-${id}"]`).hover();
      await actions.locator('summary', { hasText: 'Verwijderen' }).click();
      await actions.getByRole('button', { name: `Ja, naar de prullenbak: ${title}` }).click();
    };

    // Linked from another page: refused, and the refusal names that page.
    await remove(target.id, `Doel ${word}`);
    await expect(page.getByText(`(1: Bron ${word})`)).toBeVisible();
    await expect(page.locator(`[id="item-${target.id}"]`)).toBeVisible();

    await page.goto(list);
    await remove(source.id, `Bron ${word}`);
    await expect(page).toHaveURL(/done=deleted/);
    await expect(page.getByText('Naar de prullenbak verplaatst')).toBeVisible();
    await expect(page.locator(`[id="item-${source.id}"]`)).toHaveCount(0);
    // Gone for the rest of the admin as well.
    const edit = await page.goto(`/admin/probe/content/${source.id}`);
    expect(edit?.status()).toBe(404);

    await page.goto('/admin/probe/content/trash');
    const row = page.getByRole('row', { name: new RegExp(`Bron ${word}`) });
    await expect(row).toBeVisible();
    await expectNoAxeViolations(page);
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'content trash', 'main');
    await page.screenshot({ path: test.info().outputPath('trash-320-200.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await setTextSize(page, '100%');

    await row.getByRole('button', { name: `Herstellen: Bron ${word}` }).click();
    await expect(page.getByText(`Offline hersteld: Bron ${word}.`)).toBeVisible();
    await page.goto(list);
    await expect(page.locator(`[id="item-${source.id}"]`)).toBeVisible();

    // The row with all its actions at the narrowest width and largest text.
    await page.setViewportSize(NARROW);
    await setTextSize(page, '200%');
    await layoutGate(page, 'content row with delete', 'main');
    await page.screenshot({ path: test.info().outputPath('row-320-200.png'), fullPage: true });
  });
});
