// The enhanced article view and native block forms save the same core document. The browser
// proof covers autosave, axe and the action layout at 320 CSS px with 200% text; the no-JS
// project proves the adjacent form can write the same prose without hydrating the editor.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { expectNoAxeViolations } from './lib/axe';
import { NARROW, layoutGate, setTextSize } from './lib/layout';
import { login } from './lib/login';

const api = () => `${process.env['E2E_API_URL']}/v1`;
const headers = () => ({ authorization: `Bearer ${process.env['MYCEL_API_KEY']}` });

async function article(request: APIRequestContext) {
  const slug = `writer-${test.info().project.name}-${Date.now()}`;
  const response = await request.post(`${api()}/content.item.create`, {
    headers: headers(),
    data: {
      slug,
      document: {
        type: 'article',
        defaultLocale: 'nl',
        locales: ['nl', 'en'],
        title: { nl: 'Een artikel', en: 'An article' },
        blocks: [
          {
            type: 'rich-text',
            version: 1,
            props: {
              content: {
                nl: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Oude tekst' }] }],
                },
                en: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old text' }] }],
                },
              },
            },
          },
        ],
      },
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { item } = (await response.json()) as { item: { id: string } };
  return `/admin/probe/content/${item.id}`;
}

test('article prose saves through the native form or the enhanced editor', async ({
  page,
  request,
}) => {
  test.skip(!process.env['E2E_API_URL'], 'run through scripts/e2e.mjs');
  const edit = await article(request);
  await login(page, edit);
  if (test.info().project.name === 'no-js') {
    const prose = page.locator('details.block').first();
    await prose.locator(':scope > summary').click();
    await prose.getByLabel(/^(Text|Tekst) \(nl\)$/).fill('Nieuwe tekst');
    await prose.getByRole('button', { name: /^(Save block|Blok opslaan)$/ }).click();
    await expect(page).toHaveURL(/\?done=blockSaved/);
    await expect(page.locator(`a[href="${edit}/write"]`)).toBeVisible();
  } else {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await page.addInitScript(() => {
      (window as Window & { writerCspViolations: string[] }).writerCspViolations = [];
      window.addEventListener('securitypolicyviolation', (event) => {
        (window as Window & { writerCspViolations: string[] }).writerCspViolations.push(
          `${event.violatedDirective}: ${event.blockedURI}`
        );
      });
    });
    await page.locator(`a[href="${edit}/write"]`).click();
    const writing = page.locator('.writing-surface .ProseMirror');
    await expect(writing).toBeVisible();
    await writing.locator('p').first().fill('Nieuwe tekst');
    await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
    expect(
      await page.evaluate(
        () => (window as Window & { writerCspViolations: string[] }).writerCspViolations
      )
    ).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await expectNoAxeViolations(page);
  }
  await page.goto(edit);
  const prose = page.locator('details.block').first();
  await prose.locator(':scope > summary').click();
  await expect(prose.getByLabel(/^(Text|Tekst) \(nl\)$/)).toHaveValue('Nieuwe tekst');
  await expect(prose.getByLabel(/^(Text|Tekst) \(en\)$/)).toHaveValue('Old text');
});

test('writer toolbar wraps whole actions at 320 CSS px and 200% text', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
  const edit = await article(request);
  await login(page, `${edit}/write`);
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'writer actions', '.writer-actions');
});

test('pasted blockquote becomes a structured quote card after attribution', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
  const edit = await article(request);
  await login(page, `${edit}/write`);
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
  await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
  await page.goto(edit);
  await expect(page.locator('details.block')).toHaveCount(2);
  await expect(page.locator('details.block').nth(1).locator(':scope > summary')).toContainText(
    /Quote|Citaat/
  );
});

test('autosave reports a newer revision and preserves its unrelated fields on retry', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
  const edit = await article(request);
  const itemId = edit.split('/').at(-1)!;
  await login(page, `${edit}/write`);
  const original = await request.post(`${api()}/content.item.get`, {
    headers: headers(),
    data: { itemId },
  });
  expect(original.ok(), await original.text()).toBe(true);
  const { revision } = (await original.json()) as {
    revision: { id: string; document: Record<string, unknown> };
  };
  const newer = await request.post(`${api()}/content.item.update`, {
    headers: headers(),
    data: {
      itemId,
      baseRevisionId: revision.id,
      document: {
        ...revision.document,
        title: { nl: 'Nieuwe kop van collega', en: 'An article' },
      },
    },
  });
  expect(newer.ok(), await newer.text()).toBe(true);
  await page.locator('.writing-surface .ProseMirror p').first().fill('Mijn nieuwe tekst');
  await expect(
    page.getByRole('heading', { name: 'Iemand anders heeft dit item intussen opgeslagen' })
  ).toBeVisible();
  await page.setViewportSize(NARROW);
  await setTextSize(page, '200%');
  await layoutGate(page, 'writer actions', '.writer-actions');
  await expect(page.getByText('Mijn nieuwe tekst').first()).toBeVisible();
  await page.getByRole('button', { name: 'Mijn tekst behouden' }).click();
  await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
  await page.goto(edit);
  await expect(page.getByLabel('Title (nl)')).toHaveValue('Nieuwe kop van collega');
  const prose = page.locator('details.block').first();
  await prose.locator(':scope > summary').click();
  await expect(prose.getByLabel('Text (nl)')).toHaveValue('Mijn nieuwe tekst');
});

test('pasted image waits for media and alternative text before saving', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
  const listed = await request.post(`${api()}/content.item.list`, {
    headers: headers(),
    data: { type: 'page', slug: 'e2e-blokken-a11y' },
  });
  expect(listed.ok(), await listed.text()).toBe(true);
  const { items } = (await listed.json()) as { items: { id: string }[] };
  const source = await request.post(`${api()}/content.item.get`, {
    headers: headers(),
    data: { itemId: items[0]!.id },
  });
  const { revision } = (await source.json()) as {
    revision: { document: { blocks: { type: string; props: { mediaId?: string } }[] } };
  };
  const mediaId = revision.document.blocks.find((block) => block.type === 'image')?.props.mediaId;
  expect(mediaId).toBeTruthy();
  const edit = await article(request);
  await login(page, `${edit}/write`);
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
  await layoutGate(page, 'writer actions', '.writer-actions');
  await expect(page.getByRole('status')).toContainText('Niet-opgeslagen wijzigingen');
  // The card's image comes from the shared media picker, not a typed id (brief media-picker).
  await page.getByRole('button', { name: 'Beeld kiezen' }).click();
  const picker = page.getByRole('dialog', { name: 'Afbeelding' });
  await picker.locator(`input[type="radio"][value="${mediaId}"]`).check();
  await picker.getByRole('button', { name: 'Klaar' }).click();
  await expect(page.getByRole('button', { name: 'Ander beeld kiezen' })).toBeVisible();
  await expect(page.getByLabel('Alternatieve tekst')).toHaveValue('Een boom');
  await page.getByRole('button', { name: 'Kaart toevoegen' }).click();
  await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
  await page.goto(edit);
  await expect(page.locator('details.block')).toHaveCount(2);
  await expect(page.locator('details.block').nth(1).locator(':scope > summary')).toContainText(
    /Image|Afbeelding/
  );
});

test('TipTap saves headings, lists, links and notes without changing stored structure', async ({
  page,
  request,
}) => {
  test.skip(test.info().project.name !== 'a11y' || !process.env['E2E_API_URL']);
  const edit = await article(request);
  const itemId = edit.split('/').at(-1)!;
  const original = await request.post(`${api()}/content.item.get`, {
    headers: headers(),
    data: { itemId },
  });
  const { revision } = (await original.json()) as { revision: { id: string; document: any } };
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
  const updated = await request.post(`${api()}/content.item.update`, {
    headers: headers(),
    data: {
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
    },
  });
  expect(updated.ok(), await updated.text()).toBe(true);
  await login(page, `${edit}/write`);
  await page.getByRole('button', { name: 'Nu opslaan' }).click();
  await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
  const saved = await request.post(`${api()}/content.item.get`, {
    headers: headers(),
    data: { itemId },
  });
  const { revision: latest } = (await saved.json()) as { revision: { document: any } };
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
  await expect
    .poll(async () => {
      const response = await request.post(`${api()}/content.item.get`, {
        headers: headers(),
        data: { itemId },
      });
      const { revision: current } = (await response.json()) as { revision: { document: any } };
      return current.document.blocks[0].props.content.nl.content[4].content[0].content[0].content
        .map((part: { text: string }) => part.text)
        .join('');
    })
    .toBe('Eerste punt aangevuld');
  await expect(page.getByRole('status')).toContainText('Alle wijzigingen opgeslagen');
  const edited = await request.post(`${api()}/content.item.get`, {
    headers: headers(),
    data: { itemId },
  });
  expect(edited.ok(), await edited.text()).toBe(true);
  const { revision: afterEdit } = (await edited.json()) as { revision: { document: any } };
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
