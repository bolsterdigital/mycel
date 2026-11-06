// flow: publish
// An operator writes an article: the enhanced writer and pasting save one core document.

import { randomUUID } from 'node:crypto';
import { systemPrincipal, useCases } from '@mycel/core';
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { expectNoAxeViolations, headingOrderProblems } from './lib/axe';
import { tenantId, withInvoker } from './lib/invoker';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';
import { closePublication, openPublication } from './lib/publication';
import { isA11y, onlyA11y } from './lib/project';
import { article, callApi, requireApi } from './lib/api';

// The enhanced article view and native block forms save the same core document. The browser
// proof covers explicit saving, axe and the action layout at 320 CSS px with 200% text; the no-JS
// project proves the adjacent form can write the same prose without hydrating the editor.
test.describe('article-writing', () => {
  test.use({ locale: 'nl-NL' });

  // ProseMirror reads the selection a moment later: a Backspace before that takes one letter, and
  // the block keeps its words. Rejected: select all, which takes the cards too (#149).
  async function emptyProse(page: Page) {
    const prose = page.locator('.writing-surface .editor-prose').first();
    await expect(prose).toBeVisible();
    await expect(async () => {
      await prose.locator('p').first().selectText();
      await page.keyboard.press('Backspace');
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
              blocks: { id: string; type: string; props: { text?: { nl?: string } } }[];
            };
          };
        }>(request, 'content.item.get', { itemId })
      ).revision.document.blocks;
    const open = async (
      page: Page,
      request: APIRequestContext,
      blocks: unknown[]
    ): Promise<string> => {
      const { item } = await callApi<{ item: { id: string } }>(request, 'content.item.create', {
        slug: `writer-gone-${test.info().project.name}-${test.info().title.length}-${Date.now()}`,
        document: {
          type: 'article',
          defaultLocale: 'nl',
          locales: ['nl'],
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
      const prose = page.locator('details.block').first();
      await prose.locator(':scope > summary').click();
      await prose.getByLabel('Tekst', { exact: true }).fill('Nieuwe tekst');
    }
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    const { revision } = await callApi(request, 'content.item.get', {
      itemId: edit.split('/').at(-1)!,
    });
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

  test('an integrated prose conflict retains input and never overwrites the newer revision', async ({
    page,
    request,
  }) => {
    onlyA11y();
    const edit = await article(request);
    const itemId = edit.split('/').at(-1)!;
    await login(page, edit);
    await expect(page.locator('.writing-surface .ProseMirror').first()).toBeVisible();
    const { revision } = await callApi(request, 'content.item.get', { itemId });
    await callApi(request, 'content.item.update', {
      itemId,
      baseRevisionId: revision.id,
      document: { ...revision.document, title: { nl: 'Kop van collega', en: 'An article' } },
    });
    await page.locator('.writing-surface .editor-prose p').first().fill('Mijn nieuwe tekst');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Iemand anders heeft dit item intussen opgeslagen' })
    ).toBeVisible();
    await expect(page.locator('.writing-surface .ProseMirror').first()).toContainText(
      'Mijn nieuwe tekst'
    );
    const saved = await callApi(request, 'content.item.get', { itemId });
    expect(saved.revision.document.title.nl).toBe('Kop van collega');
    expect(saved.revision.document.blocks[0].props.content.nl).toEqual(
      revision.document.blocks[0].props.content.nl
    );
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

  test('pasted image waits for media and alternative text before saving', async ({
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
    await expect(page.getByLabel('Alternatieve tekst')).toHaveValue('Een boom');
    await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
    await page.getByRole('button', { name: 'Opslaan', exact: true }).click();
    await expect(page).toHaveURL(/saved/);
    await page.goto(edit);
    await expect(page.locator('details.block')).toHaveCount(2);
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
      await expect(page.getByRole('status')).toContainText('Ter publicatie aangeboden in nl.');
      await openPublication(page);
      await expect(card).toContainText(/Ter publicatie aangeboden op \d{4}-\d{2}-\d{2}/);
      await expect(card).toContainText('Notitie: Graag vóór vrijdag');
      await expectNoAxeViolations(page);
      expect(await offers()).toEqual([expect.objectContaining({ detail: 'Een artikel' })]);

      await card.getByRole('button', { name: 'Aanbieding intrekken' }).click();
      await expect(page).toHaveURL(`${edit}?done=withdrawOffer&locale=nl`);
      await expect(page.getByRole('status')).toContainText('Aanbieding ingetrokken in nl.');
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
});
